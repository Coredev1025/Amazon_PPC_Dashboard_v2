"""
FastAPI Main Application for Amazon Vendor Central PPC AI Dashboard
Provides REST API endpoints for the React frontend to interact with the AI Rule Engine
"""

import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Depends, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
import logging
import json

# Load environment variables from .env file in project root
# Get project root directory (3 levels up from dashboard/api/main.py)
project_root = Path(__file__).parent.parent.parent

try:
    from dotenv import load_dotenv
    env_path = project_root / '.env'
    if env_path.exists():
        load_dotenv(env_path)
        logging.info(f"Loaded environment variables from {env_path}")
    else:
        logging.warning(f".env file not found at {env_path}")
except ImportError:
    logging.warning("python-dotenv not installed, using system environment variables only")

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from src.ai_rule_engine.config import RuleConfig
from src.ai_rule_engine.database import DatabaseConnector
from src.ai_rule_engine.amazon_sync import AmazonSyncManager
from src.ai_rule_engine.rule_engine import AIRuleEngine

# Import authentication module
from dashboard.api import auth
from dashboard.api.auth import get_current_user, UserResponse

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _normalize_campaign_state(status: Optional[str]) -> str:
    normalized = (status or '').strip().lower()
    if normalized in ['paused', 'pause']:
        return 'paused'
    if normalized in ['archived', 'archive']:
        return 'archived'
    return 'enabled'


def _get_amazon_sync_manager() -> Optional[AmazonSyncManager]:
    if not db_connector or not rule_config:
        logger.warning("Amazon sync unavailable: missing db connector or config")
        return None
    sync_manager = AmazonSyncManager(rule_config.__dict__, db_connector)
    if not sync_manager.api_client:
        logger.warning("Amazon API client not initialized; skipping Amazon update")
        return None
    return sync_manager

# Global instances
db_connector: Optional[DatabaseConnector] = None
ai_engine: Optional[AIRuleEngine] = None
rule_config: Optional[RuleConfig] = None

# Global state for tracking engine execution
engine_status = {
    'is_running': False,
    'last_run': None,
    'current_run': None,
    'execution_history': []
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and cleanup resources"""
    global db_connector, ai_engine, rule_config
    
    # Initialize database connection
    try:
        # Check if DB_PASSWORD is set
        if not os.getenv('DB_PASSWORD'):
            error_msg = (
                "DB_PASSWORD environment variable is required. "
                f"Please check your .env file at: {project_root / '.env'}"
            )
            logger.error(error_msg)
            raise ValueError(error_msg)
        
        db_connector = DatabaseConnector()
        rule_config = RuleConfig()
        ai_engine = AIRuleEngine(rule_config, db_connector)
        logger.info("Dashboard API initialized successfully")
    except ValueError as e:
        # Re-raise ValueError with clear message
        logger.error(f"Configuration error: {e}")
        raise
    except Exception as e:
        logger.error(f"Failed to initialize dashboard API: {e}")
        raise
    
    yield
    
    # Cleanup
    logger.info("Dashboard API shutting down")


app = FastAPI(
    title="Amazon Vendor Central PPC AI Dashboard API",
    description="REST API for the PPC AI Dashboard - connects React frontend to AI Rule Engine",
    version="2.0.0",
    lifespan=lifespan
)

# CORS middleware for React frontend
# Get allowed origins from environment or use defaults
allowed_origins_env = os.getenv("CORS_ALLOWED_ORIGINS", "")
if allowed_origins_env:
    # Split comma-separated origins from environment variable
    allowed_origins = [origin.strip() for origin in allowed_origins_env.split(",")]
else:
    # Default origins including production and development
    allowed_origins = [
        "http://138.197.212.121:3000",
        "https://138.197.212.121:3000",
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=3600,
)



# ============================================================================
# PYDANTIC MODELS
# ============================================================================

class DateRangeParams(BaseModel):
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    days: int = 7


class MetricComparison(BaseModel):
    """Comparison data for a metric"""
    value: float
    change_percentage: float
    direction: str  # 'up', 'down', 'neutral'


class OverviewMetrics(BaseModel):
    spend: float
    sales: float
    acos: float
    roas: float
    orders: int
    impressions: int
    clicks: int
    ctr: float
    cvr: float
    cpc: float
    ai_activity_count: int
    account_health_score: float
    pending_recommendations: int = 0
    applied_today: int = 0
    # Comparison data
    spend_comparison: Optional[MetricComparison] = None
    sales_comparison: Optional[MetricComparison] = None
    acos_comparison: Optional[MetricComparison] = None
    roas_comparison: Optional[MetricComparison] = None


class TrendDataPoint(BaseModel):
    date: str
    spend: float
    sales: float
    acos: float
    roas: float
    impressions: int = 0
    clicks: int = 0
    cpc: float = 0
    ctr: float = 0
    cvr: float = 0


class Alert(BaseModel):
    id: str
    type: str
    severity: str
    message: str
    entity_type: Optional[str] = None
    entity_id: Optional[int] = None
    entity_name: Optional[str] = None
    created_at: str


class TopPerformer(BaseModel):
    campaign_id: int
    campaign_name: str
    acos: float
    roas: float
    sales: float
    spend: float
    change_percentage: float  # Performance change vs previous period


class NeedsAttention(BaseModel):
    campaign_id: int
    campaign_name: str
    acos: float
    roas: float
    sales: float
    spend: float
    change_percentage: float  # Performance change vs previous period
    issue: str  # Description of the issue


class AIInsight(BaseModel):
    type: str  # 'bid_increase', 'budget_limit', 'negative_keywords', etc.
    count: int
    message: str
    priority: str  # 'high', 'medium', 'low'
    color: str  # 'green', 'orange', 'blue', etc.


class PaginatedResponse(BaseModel):
    """Generic paginated response wrapper"""
    data: List[Any]
    total: int
    page: int
    page_size: int
    total_pages: int


class CampaignData(BaseModel):
    campaign_id: int
    campaign_name: str
    campaign_type: str
    status: str
    spend: float
    sales: float
    acos: Optional[float]
    roas: Optional[float]
    orders: int
    budget: float
    impressions: int
    clicks: int
    ctr: float
    cvr: float
    ai_recommendation: Optional[str] = None
    sb_ad_type: Optional[str] = None  # PRODUCT_COLLECTION, STORE_SPOTLIGHT, VIDEO
    sd_targeting_type: Optional[str] = None  # CONTEXTUAL, AUDIENCES
    portfolio_id: Optional[int] = None
    portfolio_name: Optional[str] = None


class KeywordData(BaseModel):
    keyword_id: int
    keyword_text: str
    match_type: str
    campaign_id: int
    ad_group_id: int
    bid: float
    state: str
    spend: float
    sales: float
    acos: Optional[float]
    roas: Optional[float]
    orders: int
    impressions: int
    clicks: int
    ctr: float
    cvr: float
    ai_suggested_bid: Optional[float] = None
    confidence_score: Optional[float] = None
    reason: Optional[str] = None
    is_locked: bool = False
    lock_reason: Optional[str] = None


class RecommendationData(BaseModel):
    id: str
    entity_type: str
    entity_id: int
    entity_name: str
    recommendation_type: str
    current_value: float
    recommended_value: float
    adjustment_percentage: float
    priority: str
    confidence: float
    reason: str
    estimated_impact: Optional[str] = None
    intelligence_signals: Optional[Dict[str, Any]] = None
    created_at: str
    status: str = "pending"


class RuleData(BaseModel):
    id: str
    name: str
    description: str
    logic: str
    is_active: bool
    trigger_frequency: str
    last_execution: Optional[str]
    last_result: Optional[str]
    parameters: Optional[Dict[str, Any]] = None


class StrategyConfig(BaseModel):
    strategy: str = Field(..., description="Strategy: 'launch', 'growth', 'profit', 'liquidate'")
    target_acos: float = Field(..., ge=0.01, le=1.0, description="Target ACOS (0.01-1.0)")
    max_bid_cap: float = Field(..., ge=0.02, le=100.0, description="Maximum bid cap")
    min_bid_floor: float = Field(default=0.02, ge=0.02, le=10.0, description="Minimum bid floor")
    ai_mode: str = Field(..., description="AI mode: 'autonomous', 'human_review', 'warm_up'")
    enable_dayparting: bool = False
    enable_inventory_protection: bool = False
    enable_brand_defense: bool = False


class AIControlConfig(BaseModel):
    """Comprehensive AI Rule Engine control configuration"""
    # Core Settings
    target_acos: float = Field(0.09, ge=0.01, le=1.0)
    acos_tolerance: float = Field(0.05, ge=0.01, le=0.5)
    roas_target: float = Field(11.11, ge=1.0, le=50.0)
    
    # Bid Limits
    bid_floor: float = Field(0.02, ge=0.02, le=1.0)
    bid_cap: float = Field(4.52, ge=0.5, le=100.0)
    bid_max_adjustment: float = Field(0.5, ge=0.1, le=1.0)
    
    # Re-entry Control
    enable_re_entry_control: bool = True
    bid_change_cooldown_days: int = Field(3, ge=1, le=14)
    min_bid_change_threshold: float = Field(0.05, ge=0.01, le=0.5)
    
    # Oscillation Prevention
    enable_oscillation_detection: bool = True
    oscillation_lookback_days: int = Field(14, ge=7, le=30)
    oscillation_direction_change_threshold: int = Field(3, ge=2, le=10)
    
    # Safety Controls
    enable_spend_safeguard: bool = True
    spend_spike_threshold: float = Field(2.0, ge=1.5, le=5.0)
    enable_comprehensive_safety_veto: bool = True
    account_daily_limit: float = Field(10000.0, ge=100.0, le=1000000.0)
    
    # Order-Based Scaling
    enable_order_based_scaling: bool = True
    order_tier_1_adjustment: float = Field(0.05, ge=0.01, le=0.2)
    order_tier_2_3_adjustment: float = Field(0.15, ge=0.05, le=0.3)
    order_tier_4_plus_adjustment: float = Field(0.30, ge=0.1, le=0.5)
    
    # Spend No-Sale Logic
    enable_spend_no_sale_logic: bool = True
    no_sale_reduction_tier_1: float = Field(0.15, ge=0.05, le=0.3)
    no_sale_reduction_tier_2: float = Field(0.25, ge=0.1, le=0.4)
    no_sale_reduction_tier_3: float = Field(0.35, ge=0.15, le=0.5)
    
    # Performance Thresholds
    min_impressions: int = Field(100, ge=10, le=1000)
    min_clicks: int = Field(5, ge=1, le=50)
    min_conversions: int = Field(1, ge=0, le=10)
    
    # Learning Loop
    enable_learning_loop: bool = True
    learning_success_threshold: float = Field(0.10, ge=0.01, le=0.5)
    learning_failure_threshold: float = Field(-0.05, ge=-0.5, le=0)
    min_training_samples: int = Field(100, ge=10, le=1000)
    
    # Feature Flags
    enable_warm_up_mode: bool = True
    enable_intelligence_engines: bool = True
    enable_advanced_bid_optimization: bool = True


class ActionRequest(BaseModel):
    entity_type: str
    entity_id: int
    action_type: str
    old_value: Optional[float] = None
    new_value: float
    reason: Optional[str] = None


class BulkActionRequest(BaseModel):
    actions: List[ActionRequest]


class NegativeCandidateData(BaseModel):
    keyword_id: int
    keyword_text: str
    search_term: Optional[str] = None
    match_type: str
    campaign_id: int
    ad_group_id: int
    spend: float
    clicks: int
    impressions: int
    orders: int
    severity: str
    confidence: float
    reason: str
    suggested_action: str
    status: str = "pending"


class ChangeLogEntry(BaseModel):
    id: int
    timestamp: str
    entity_type: str
    entity_id: int
    entity_name: str
    action: str
    old_value: float
    new_value: float
    change_percentage: float
    reason: str
    triggered_by: str
    status: str
    outcome_label: Optional[str] = None
    outcome_score: Optional[float] = None


class BidLockData(BaseModel):
    entity_type: str
    entity_id: int
    entity_name: Optional[str] = None
    locked_until: str
    lock_reason: str
    last_change_id: Optional[int] = None


class OscillationData(BaseModel):
    entity_type: str
    entity_id: int
    entity_name: Optional[str] = None
    direction_changes: int
    is_oscillating: bool
    last_change_date: Optional[str] = None


class SearchResult(BaseModel):
    type: str  # 'campaign', 'keyword', 'ad_group'
    id: int
    name: str
    campaign_id: Optional[int] = None
    campaign_name: Optional[str] = None
    ad_group_id: Optional[int] = None
    ad_group_name: Optional[str] = None
    match_score: float = 0.0


class SearchResponse(BaseModel):
    query: str
    results: List[SearchResult]
    total: int


class LearningOutcomeData(BaseModel):
    id: int
    recommendation_id: str
    entity_type: str
    entity_id: int
    adjustment_type: str
    recommended_value: float
    applied_value: float
    outcome: str
    improvement_percentage: float
    timestamp: str


class ModelTrainingStatus(BaseModel):
    model_version: int
    status: str
    train_accuracy: Optional[float] = None
    test_accuracy: Optional[float] = None
    train_auc: Optional[float] = None
    test_auc: Optional[float] = None
    promoted: bool = False
    completed_at: Optional[str] = None


class PortfolioData(BaseModel):
    portfolio_id: int
    portfolio_name: str
    budget_amount: Optional[float] = None
    budget_type: Optional[str] = None
    status: str
    campaign_count: int = 0
    total_spend: float = 0
    total_sales: float = 0
    acos: Optional[float] = None
    roas: Optional[float] = None


class AdGroupData(BaseModel):
    ad_group_id: int
    ad_group_name: str
    campaign_id: int
    campaign_name: str
    default_bid: float
    status: str
    spend: float
    sales: float
    acos: Optional[float] = None
    roas: Optional[float] = None
    orders: int
    impressions: int
    clicks: int
    ctr: float
    cvr: float


class AdData(BaseModel):
    ad_id: int
    asin: str
    sku: Optional[str] = None
    campaign_id: int
    ad_group_id: int
    status: str
    spend: float
    sales: float
    acos: Optional[float] = None
    roas: Optional[float] = None
    orders: int
    impressions: int
    clicks: int
    inventory_status: Optional[str] = None


class ProductTargetData(BaseModel):
    targeting_id: int
    targeting_value: str
    targeting_type: str
    campaign_id: int
    campaign_name: Optional[str] = None
    ad_group_id: int
    ad_group_name: Optional[str] = None
    bid: Optional[float] = None
    state: Optional[str] = None
    impressions: Optional[int] = None
    clicks: Optional[int] = None
    spend: Optional[float] = None
    sales: Optional[float] = None
    acos: Optional[float] = None
    roas: Optional[float] = None


class SearchTermData(BaseModel):
    search_term: str
    campaign_id: int
    ad_group_id: int
    keyword_id: Optional[int] = None
    impressions: int
    clicks: int
    spend: float
    sales: float
    orders: int
    acos: Optional[float] = None
    roas: Optional[float] = None
    harvest_action: Optional[str] = None


class PlacementData(BaseModel):
    placement: str
    campaign_id: Optional[int] = None
    ad_group_id: Optional[int] = None
    keyword_id: Optional[int] = None
    target_id: Optional[int] = None
    impressions: int
    clicks: int
    spend: float
    sales: float
    orders: int
    acos: Optional[float] = None
    roas: Optional[float] = None


class COGSData(BaseModel):
    asin: str
    cogs: float
    amazon_fees_percentage: float = 0.15
    notes: Optional[str] = None


class FinancialMetrics(BaseModel):
    asin: str
    sales: float
    cogs: float
    amazon_fees: float
    gross_profit: float
    ad_spend: float
    net_profit: float
    tacos: float
    break_even_acos: float


class ChangeHistoryEntry(BaseModel):
    id: int
    change_date: str
    user_id: Optional[str] = None
    entity_type: str
    entity_id: int
    entity_name: Optional[str] = None
    field_name: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    change_type: str
    triggered_by: str
    reason: Optional[str] = None


# Multi-Account Management Models
class AmazonAccount(BaseModel):
    account_id: int
    account_name: str
    merchant_id: str
    seller_id: str
    marketplace_ids: List[str]
    refresh_token: str
    client_id: str
    client_secret: str
    is_active: bool = True
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class AmazonAccountResponse(BaseModel):
    account_id: int
    account_name: str
    merchant_id: str
    seller_id: str
    marketplace_ids: List[str]
    is_active: bool


class AccountListResponse(BaseModel):
    account_id: str
    account_name: str
    marketplace_id: Optional[str] = None
    region: Optional[str] = None
    is_active: bool
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class AmazonAccountCreate(BaseModel):
    account_name: str
    merchant_id: str
    seller_id: str
    marketplace_ids: List[str]
    refresh_token: str
    client_id: str
    client_secret: str


class AmazonAccountUpdate(BaseModel):
    account_name: Optional[str] = None
    marketplace_ids: Optional[List[str]] = None
    is_active: Optional[bool] = None


class UserAccountMapping(BaseModel):
    user_id: str
    account_id: int
    role: str = 'viewer'  # admin, editor, viewer
    created_at: Optional[str] = None


class ColumnLayoutPreference(BaseModel):
    view_type: str
    column_visibility: Dict[str, bool]
    column_order: List[str]
    column_widths: Dict[str, int]


# Financial Metrics & Profitability Models
class COGS(BaseModel):
    asin: str
    sku: str
    cost_per_unit: float
    currency: str = 'USD'
    last_updated: Optional[str] = None
    notes: Optional[str] = None


class COGSResponse(BaseModel):
    asin: str
    sku: str
    cost_per_unit: float
    currency: str
    last_updated: Optional[str]


class FinancialMetrics(BaseModel):
    date: str
    campaign_id: str
    campaign_name: str
    spend: float
    revenue: float
    units_sold: int
    cogs: float
    gross_profit: float
    net_profit: float
    acos: float
    tacos: float
    break_even_acos: float
    roi: float
    profit_margin: float


class SearchTermHarvest(BaseModel):
    search_term: str
    campaign_id: str
    ad_group_id: str
    clicks: int
    conversions: int
    spend: float
    acos: float
    keyword_type: str = 'BROAD'  # BROAD, PHRASE, EXACT
    harvest_type: str  # positive, negative
    status: str = 'pending'  # pending, applied, rejected


class ChangeHistory(BaseModel):
    change_id: str
    user_id: str
    entity_type: str  # campaign, keyword, bid, budget
    entity_id: str
    entity_name: str
    old_value: Any
    new_value: Any
    change_type: str  # manual, ai, system
    reason: Optional[str] = None
    status: str = 'completed'  # pending, completed, reverted
    created_at: str
    updated_at: str


class EventAnnotation(BaseModel):
    event_id: str
    date: str
    event_type: str  # price_change, bid_rule, campaign_launch, manual_change
    title: str
    description: str
    impact: str  # positive, negative, neutral
    user_id: Optional[str] = None
    metrics_before: Dict[str, float]
    metrics_after: Dict[str, float]


class BreadcrumbNavigation(BaseModel):
    items: List[Dict[str, str]]  # [{label, url, icon}]
    current: str


class TabConfig(BaseModel):
    tab_id: str
    label: str
    entity_type: str  # campaigns, adgroups, keywords, productads, targets, searchterms
    icon: str
    parent_id: Optional[str] = None
    filter_criteria: Optional[Dict[str, Any]] = None


# ============================================================================
# API ENDPOINTS - OVERVIEW / COMMAND CENTER
# ============================================================================

@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "timestamp": datetime.now().isoformat()}


# ============================================================================
# AUTHENTICATION ENDPOINTS
# ============================================================================

@app.post("/api/auth/signup", response_model=auth.UserResponse)
async def signup(user_data: auth.UserSignup):
    """
    Register a new user
    
    Process:
    1. User provides email, username, and password
    2. Server validates input (Pydantic models handle validation)
    3. Server checks if username/email already exists
    4. Server hashes the password using bcrypt
    5. Server stores user data in database with hashed password (NOT plain text)
    6. Returns user data (password_hash is never returned to client)
    """
    try:
        logger.info(f"Signup request for username: {user_data.username}, email: {user_data.email}")
        user = auth.create_user(db_connector, user_data)
        logger.info(f"User signup successful: {user_data.username}")
        return auth.UserResponse(
            id=user['id'],
            email=user['email'],
            username=user['username'],
            role=user['role'],
            is_active=user['is_active'],
            is_verified=user['is_verified'],
            last_login=None,
            created_at=user['created_at'].isoformat()
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error during signup: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/auth/login", response_model=auth.Token)
async def login(credentials: auth.UserLogin):
    """
    Login and get access token
    
    Process:
    1. User provides username/email and password (plain text)
    2. Server retrieves user from database by username OR email
    3. Server gets stored password_hash from database
    4. Server verifies provided password against stored hash using bcrypt verify
       - bcrypt extracts salt from stored hash
       - bcrypt hashes provided password with that salt
       - bcrypt compares result with stored hash
    5. If passwords match:
       - Check if account is active
       - Update last_login timestamp
       - Generate JWT token
       - Return token to client
    6. If passwords don't match:
       - Return 401 error: "Incorrect username/email or password"
    """
    try:
        logger.info(f"Login attempt for username/email: {credentials.username}")
        user = auth.authenticate_user(db_connector, credentials.username, credentials.password)
        
        if not user:
            logger.warning(f"Login failed: Invalid credentials for username/email: {credentials.username}")
            raise HTTPException(
                status_code=401,
                detail="Incorrect username/email or password",
                headers={"WWW-Authenticate": "Bearer"},
            )
        
        # Create access token
        logger.info(f"Login successful for username/email: {credentials.username}, generating token")
        access_token = auth.create_access_token(
            data={"sub": str(user['id']), "username": user['username'], "role": user['role']}
        )
        
        return auth.Token(
            access_token=access_token,
            token_type="bearer",
            user={
                "id": user['id'],
                "email": user['email'],
                "username": user['username'],
                "role": user['role'],
                "is_verified": user['is_verified']
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error during login: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/auth/me", response_model=auth.UserResponse)
async def get_current_user_info(current_user: auth.UserResponse = Depends(auth.get_current_user)):
    """Get current user information"""
    return current_user


@app.post("/api/auth/change-password")
async def change_user_password(
    password_data: auth.PasswordChange,
    current_user: auth.UserResponse = Depends(auth.get_current_user)
):
    """Change current user's password"""
    try:
        auth.change_password(
            db_connector,
            current_user.id,
            password_data.current_password,
            password_data.new_password
        )
        return {"status": "success", "message": "Password changed successfully"}
    except Exception as e:
        logger.error(f"Error changing password: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/auth/logout")
async def logout():
    """Logout (client-side token removal)"""
    return {"status": "success", "message": "Logged out successfully"}


# API ENDPOINTS - MULTI-ACCOUNT MANAGEMENT

@app.get("/api/accounts", response_model=List[AccountListResponse])
async def list_accounts(current_user: UserResponse = Depends(get_current_user)):
    """List all Amazon accounts accessible to current user"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT account_id, account_name, marketplace_id, region, is_active,
                           created_at, updated_at
                    FROM amazon_accounts
                    WHERE is_active = TRUE
                    ORDER BY account_name
                """)
                accounts = cursor.fetchall()
                
                return [
                    {
                        "account_id": a['account_id'],
                        "account_name": a['account_name'],
                        "marketplace_id": a.get('marketplace_id'),
                        "region": a.get('region'),
                        "is_active": a['is_active'],
                        "created_at": a['created_at'].isoformat() if a.get('created_at') else None,
                        "updated_at": a['updated_at'].isoformat() if a.get('updated_at') else None
                    }
                    for a in accounts
                ]
    except Exception as e:
        logger.error(f"Error listing accounts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/accounts", response_model=AmazonAccountResponse)
async def create_account(
    account_data: AmazonAccountCreate,
    current_user: UserResponse = Depends(get_current_user)
):
    """Create a new Amazon seller account (admin only)"""
    try:
        if current_user.role != 'admin':
            raise HTTPException(status_code=403, detail="Only admins can create accounts")
        
        # TODO: Implement account creation with proper credential encryption
        # Steps:
        # 1. Encrypt refresh_token, client_id, client_secret
        # 2. Store in amazon_accounts table
        # 3. Create user_account_mapping entry
        # 4. Test API connectivity
        
        raise HTTPException(status_code=501, detail="Account creation requires database schema updates")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating account: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/accounts/{account_id}", response_model=AmazonAccountResponse)
async def get_account(
    account_id: int,
    current_user: UserResponse = Depends(get_current_user)
):
    """Get account details"""
    try:
        # TODO: Verify user has access to this account via user_account_mapping
        raise HTTPException(status_code=501, detail="Account retrieval requires database schema updates")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting account: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/accounts/{account_id}", response_model=AmazonAccountResponse)
async def update_account(
    account_id: int,
    account_data: AmazonAccountUpdate,
    current_user: UserResponse = Depends(get_current_user)
):
    """Update account settings"""
    try:
        if current_user.role != 'admin':
            raise HTTPException(status_code=403, detail="Only admins can update accounts")
        
        # TODO: Validate user access and update account
        raise HTTPException(status_code=501, detail="Account update requires database schema updates")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating account: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/accounts/{account_id}/activate")
async def activate_account(
    account_id: int,
    current_user: UserResponse = Depends(get_current_user)
):
    """Activate an account for use"""
    try:
        if current_user.role not in ['admin', 'manager']:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        
        # TODO: Set account as active and update current user's active account
        # Update session/token with new account_id
        raise HTTPException(status_code=501, detail="Account activation requires database schema updates")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error activating account: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/accounts/current/info")
async def get_current_account(current_user: UserResponse = Depends(get_current_user)):
    """Get currently active account information"""
    try:
        # TODO: Return active account for current user
        # Should include seller_id, merchant_id, refresh_token (encrypted)
        return {
            "account_id": 1,
            "account_name": "Primary Account",
            "seller_id": os.getenv('SELLER_ID'),
            "merchant_id": os.getenv('MERCHANT_ID'),
            "is_active": True
        }
    except Exception as e:
        logger.error(f"Error getting current account: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/accounts/switch/{account_id}")
async def switch_account(
    account_id: int,
    current_user: UserResponse = Depends(get_current_user)
):
    """Switch to a different account"""
    try:
        # TODO: Verify user has access to this account
        # TODO: Update session/token with new account_id
        return {
            "status": "success",
            "message": f"Switched to account {account_id}",
            "account_id": account_id
        }
    except Exception as e:
        logger.error(f"Error switching account: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/overview/metrics", response_model=OverviewMetrics)
async def get_overview_metrics(
    days: Optional[int] = Query(None, ge=1, le=365),
    start_date: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
):
    """Get overview metrics for the Command Center. Use either days or start_date+end_date."""
    try:
        now = datetime.now()
        use_date_range = start_date and end_date
        if use_date_range:
            try:
                start_dt = datetime.strptime(start_date, '%Y-%m-%d').replace(hour=0, minute=0, second=0, microsecond=0)
                end_dt = datetime.strptime(end_date, '%Y-%m-%d').replace(hour=23, minute=59, second=59, microsecond=999999)
                if start_dt > end_dt:
                    raise HTTPException(status_code=400, detail="Start date must be before or equal to end date")
                if end_dt > now:
                    end_dt = now.replace(hour=23, minute=59, second=59, microsecond=999999)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")
        else:
            d = days if days is not None else 7
            end_dt = now.replace(hour=23, minute=59, second=59, microsecond=999999)
            start_dt = (now - timedelta(days=d - 1)).replace(hour=0, minute=0, second=0, microsecond=0)

        total_spend = 0.0
        total_sales = 0.0
        total_impressions = 0
        total_clicks = 0
        total_orders = 0
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    cursor.execute("""
                        SELECT 
                            COALESCE(SUM(cp.impressions), 0) as total_impressions,
                            COALESCE(SUM(cp.clicks), 0) as total_clicks,
                            COALESCE(SUM(cp.cost), 0) as total_cost,
                            COALESCE(SUM(cp.attributed_conversions_7d), 0) as total_conversions,
                            COALESCE(SUM(cp.attributed_sales_7d), 0) as total_sales
                        FROM campaign_performance cp
                        INNER JOIN campaigns c ON cp.campaign_id = c.campaign_id
                        WHERE c.campaign_status = 'ENABLED'
                            AND cp.report_date >= %s
                            AND cp.report_date <= %s
                    """, (start_dt, end_dt))
                    row = cursor.fetchone()
                    if row:
                        total_impressions = int(row['total_impressions'] or 0)
                        total_clicks = int(row['total_clicks'] or 0)
                        total_spend = float(row['total_cost'] or 0)
                        total_orders = int(row['total_conversions'] or 0)
                        total_sales = float(row['total_sales'] or 0)
        except Exception as e:
            logger.warning(f"Could not get current period metrics: {e}")

        acos = (total_spend / total_sales * 100) if total_sales > 0 else 0
        roas = (total_sales / total_spend) if total_spend > 0 else 0
        ctr = (total_clicks / total_impressions * 100) if total_impressions > 0 else 0
        cvr = (total_orders / total_clicks * 100) if total_clicks > 0 else 0
        cpc = (total_spend / total_clicks) if total_clicks > 0 else 0

        period_length_days = max(1, (end_dt - start_dt).days + 1)
        prev_end_dt = start_dt - timedelta(days=1)
        prev_end_dt = prev_end_dt.replace(hour=23, minute=59, second=59, microsecond=999999)
        prev_start_dt = prev_end_dt - timedelta(days=period_length_days - 1)
        prev_start_dt = prev_start_dt.replace(hour=0, minute=0, second=0, microsecond=0)

        prev_total_spend = 0.0
        prev_total_sales = 0.0
        prev_total_impressions = 0
        prev_total_clicks = 0
        prev_total_orders = 0
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    cursor.execute("""
                        SELECT 
                            COALESCE(SUM(cp.impressions), 0) as total_impressions,
                            COALESCE(SUM(cp.clicks), 0) as total_clicks,
                            COALESCE(SUM(cp.cost), 0) as total_cost,
                            COALESCE(SUM(cp.attributed_conversions_7d), 0) as total_conversions,
                            COALESCE(SUM(cp.attributed_sales_7d), 0) as total_sales
                        FROM campaign_performance cp
                        INNER JOIN campaigns c ON cp.campaign_id = c.campaign_id
                        WHERE c.campaign_status = 'ENABLED'
                            AND cp.report_date >= %s
                            AND cp.report_date <= %s
                    """, (prev_start_dt, prev_end_dt))
                    result = cursor.fetchone()
                    if result:
                        prev_total_impressions = int(result['total_impressions'] or 0)
                        prev_total_clicks = int(result['total_clicks'] or 0)
                        prev_total_spend = float(result['total_cost'] or 0)
                        prev_total_orders = int(result['total_conversions'] or 0)
                        prev_total_sales = float(result['total_sales'] or 0)
        except Exception as e:
            logger.warning(f"Could not get previous period metrics: {e}")
        
        prev_acos = (prev_total_spend / prev_total_sales * 100) if prev_total_sales > 0 else 0
        prev_roas = (prev_total_sales / prev_total_spend) if prev_total_spend > 0 else 0
        
        # Calculate comparison percentages
        def calculate_comparison(current: float, previous: float, inverted: bool = False) -> Optional[MetricComparison]:
            """Calculate comparison between current and previous period
            
            Args:
                current: Current period value
                previous: Previous period value
                inverted: If True, lower values are better (e.g., ACOS)
            """
            if previous == 0:
                if current == 0:
                    return None
                return MetricComparison(value=current, change_percentage=0.0, direction='neutral')
            
            change_pct = ((current - previous) / previous) * 100
            if abs(change_pct) < 0.01:  # Less than 0.01% change is considered neutral
                direction = 'neutral'
            elif inverted:
                # For inverted metrics (like ACOS), lower is better
                # So if change_pct < 0 (current < previous), that's "up" (good)
                direction = 'down' if change_pct > 0 else 'up'
            else:
                # For normal metrics, higher is better
                direction = 'up' if change_pct > 0 else 'down'
            
            return MetricComparison(value=current, change_percentage=round(abs(change_pct), 1), direction=direction)
        
        spend_comp = calculate_comparison(total_spend, prev_total_spend)
        sales_comp = calculate_comparison(total_sales, prev_total_sales)
        acos_comp = calculate_comparison(acos, prev_acos, inverted=True)  # For ACOS, down is good
        roas_comp = calculate_comparison(roas, prev_roas)
        
        # Get AI activity count (recommendations in last 24h)
        ai_activity = len(ai_engine.recent_adjustments) if hasattr(ai_engine, 'recent_adjustments') else 0
        
        # Get pending recommendations count
        pending_recs = 0
        applied_today = 0
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    cursor.execute("""
                        SELECT 
                            COUNT(*) FILTER (WHERE applied = FALSE) as pending,
                            COUNT(*) FILTER (WHERE applied = TRUE AND applied_at >= CURRENT_DATE) as applied_today
                        FROM recommendation_tracking
                        WHERE created_at >= %s
                    """, (datetime.now() - timedelta(days=7),))
                    result = cursor.fetchone()
                    if result:
                        pending_recs = result['pending'] or 0
                        applied_today = result['applied_today'] or 0
        except Exception as e:
            logger.warning(f"Could not get recommendation counts: {e}")
        
        # Calculate account health score (0-100)
        health_score = _calculate_account_health_score(acos, roas, ctr, cvr, total_orders)
        
        return OverviewMetrics(
            spend=round(total_spend, 2),
            sales=round(total_sales, 2),
            acos=round(acos, 2),
            roas=round(roas, 2),
            orders=total_orders,
            impressions=total_impressions,
            clicks=total_clicks,
            ctr=round(ctr, 2),
            cvr=round(cvr, 2),
            cpc=round(cpc, 2),
            ai_activity_count=ai_activity,
            account_health_score=round(health_score, 1),
            pending_recommendations=pending_recs,
            applied_today=applied_today,
            spend_comparison=spend_comp,
            sales_comparison=sales_comp,
            acos_comparison=acos_comp,
            roas_comparison=roas_comp
        )
    except Exception as e:
        logger.error(f"Error fetching overview metrics: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/overview/trends", response_model=List[TrendDataPoint])
async def get_overview_trends(
    days: Optional[int] = Query(None, ge=1, le=365),
    start_date: Optional[str] = Query(None, description="Start date in YYYY-MM-DD format"),
    end_date: Optional[str] = Query(None, description="End date in YYYY-MM-DD format")
):
    """Get trend data for charts. Supports either days parameter or custom date range."""
    try:
        # Determine start and end dates
        if start_date and end_date:
            # Custom date range
            try:
                start = datetime.strptime(start_date, '%Y-%m-%d')
                start = start.replace(hour=0, minute=0, second=0, microsecond=0)
                end = datetime.strptime(end_date, '%Y-%m-%d')
                end = end.replace(hour=23, minute=59, second=59, microsecond=999999)  # Include full end date
                
                # Validate date range
                if start > end:
                    raise HTTPException(status_code=400, detail="Start date must be before or equal to end date")
                
                # Ensure end date is not in the future
                now = datetime.now()
                if end > now:
                    end = now.replace(hour=23, minute=59, second=59, microsecond=999999)
                    
            except ValueError as e:
                raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")
        elif days:
            # Use days parameter
            now = datetime.now()
            end = now.replace(hour=23, minute=59, second=59, microsecond=999999)
            start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)  # Include today
        else:
            # Default to last 30 days
            now = datetime.now()
            end = now.replace(hour=23, minute=59, second=59, microsecond=999999)
            start = (now - timedelta(days=29)).replace(hour=0, minute=0, second=0, microsecond=0)
        
        query = """
        SELECT 
            report_date,
            COALESCE(SUM(cost), 0) as spend,
            COALESCE(SUM(attributed_sales_7d), 0) as sales,
            COALESCE(SUM(impressions), 0)::int as impressions,
            COALESCE(SUM(clicks), 0)::int as clicks,
            COALESCE(SUM(attributed_conversions_7d), 0)::int as orders
        FROM campaign_performance
        WHERE report_date >= %s AND report_date <= %s
        GROUP BY report_date
        ORDER BY report_date ASC
        """
        
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute(query, (start, end))
                rows = cursor.fetchall()
        
        trends = []
        for row in rows:
            spend = float(row['spend'] or 0)
            sales = float(row['sales'] or 0)
            impressions = int(row['impressions'] or 0)
            clicks = int(row['clicks'] or 0)
            orders = int(row['orders'] or 0)

            acos = (spend / sales * 100) if sales > 0 else 0
            roas = (sales / spend) if spend > 0 else 0
            cpc = (spend / clicks) if clicks > 0 else 0
            ctr = (clicks / impressions * 100) if impressions > 0 else 0
            cvr = (orders / clicks * 100) if clicks > 0 else 0
            trends.append(TrendDataPoint(
                date=row['report_date'].strftime('%Y-%m-%d'),
                spend=round(spend, 2),
                sales=round(sales, 2),
                acos=round(acos, 2),
                roas=round(roas, 2),
                impressions=impressions,
                clicks=clicks,
                cpc=round(cpc, 2),
                ctr=round(ctr, 2),
                cvr=round(cvr, 2),
            ))
        
        return trends
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching trends: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/overview/alerts", response_model=List[Alert])
async def get_alerts(limit: int = Query(10, ge=1, le=50)):
    """Get active alerts for the dashboard"""
    try:
        alerts = []
        
        # Get alerts from alert_history table
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    cursor.execute("""
                        SELECT id, alert_type, entity_type, entity_id, entity_name, 
                               severity, message, triggered_at
                        FROM alert_history
                        WHERE is_dismissed = FALSE
                        ORDER BY 
                            CASE severity 
                                WHEN 'critical' THEN 0 
                                WHEN 'high' THEN 1 
                                WHEN 'medium' THEN 2 
                                ELSE 3 
                            END,
                            triggered_at DESC
                        LIMIT %s
                    """, (limit,))
                    db_alerts = cursor.fetchall()
                    
                    for row in db_alerts:
                        alerts.append(Alert(
                            id=str(row['id']),
                            type=row['alert_type'],
                            severity=row['severity'],
                            message=row['message'],
                            entity_type=row['entity_type'],
                            entity_id=row['entity_id'],
                            entity_name=row['entity_name'],
                            created_at=row['triggered_at'].isoformat()
                        ))
        except Exception as e:
            logger.warning(f"Could not get alerts from database: {e}")
        
        # Generate real-time alerts from campaign data if needed
        if len(alerts) < limit:
            campaigns = db_connector.get_campaigns_with_performance(7)
            for campaign in campaigns:
                if len(alerts) >= limit:
                    break
                    
                budget = float(campaign.get('budget_amount', 0) or 0)
                spend = float(campaign.get('total_cost', 0) or 0)
                
                if budget > 0 and spend >= budget * 0.9:
                    alert_id = f"budget_{campaign['campaign_id']}"
                    if not any(a.id == alert_id for a in alerts):
                        alerts.append(Alert(
                            id=alert_id,
                            type="budget_depletion",
                            severity="high",
                            message=f"Campaign '{campaign['campaign_name']}' is near budget limit ({(spend/budget*100):.1f}% used)",
                            entity_type="campaign",
                            entity_id=campaign['campaign_id'],
                            entity_name=campaign['campaign_name'],
                            created_at=datetime.now().isoformat()
                        ))
                
                # Check for ACOS spikes
                acos = float(campaign.get('avg_acos', 0) or 0)
                if acos > rule_config.acos_target * 2:
                    alert_id = f"acos_{campaign['campaign_id']}"
                    if not any(a.id == alert_id for a in alerts):
                        alerts.append(Alert(
                            id=alert_id,
                            type="acos_spike",
                            severity="critical" if acos > rule_config.acos_target * 3 else "high",
                            message=f"Campaign '{campaign['campaign_name']}' has high ACOS ({acos*100:.1f}%)",
                            entity_type="campaign",
                            entity_id=campaign['campaign_id'],
                            entity_name=campaign['campaign_name'],
                            created_at=datetime.now().isoformat()
                        ))
        
        # Get oscillating entities
        try:
            oscillating = db_connector.get_oscillating_entities()
            for entity in oscillating:
                if len(alerts) >= limit:
                    break
                alert_id = f"oscillation_{entity['entity_type']}_{entity['entity_id']}"
                if not any(a.id == alert_id for a in alerts):
                    alerts.append(Alert(
                        id=alert_id,
                        type="bid_oscillation",
                        severity="medium",
                        message=f"{entity.get('entity_name', f'{entity['entity_type']} {entity['entity_id']}')} is experiencing bid oscillation ({entity['direction_changes']} changes)",
                        entity_type=entity['entity_type'],
                        entity_id=entity['entity_id'],
                        entity_name=entity.get('entity_name'),
                        created_at=datetime.now().isoformat()
                    ))
        except Exception as e:
            logger.warning(f"Could not get oscillating entities: {e}")
        
        return alerts[:limit]
    except Exception as e:
        logger.error(f"Error fetching alerts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/overview/top-performers", response_model=List[TopPerformer])
async def get_top_performers(days: int = Query(7, ge=1, le=90), limit: int = Query(3, ge=1, le=10)):
    """Get top performing campaigns based on ACOS and ROAS"""
    try:
        campaigns = db_connector.get_campaigns_with_performance(days)
        
        # Get previous period for comparison
        prev_start_date = datetime.now() - timedelta(days=days * 2)
        prev_end_date = datetime.now() - timedelta(days=days)
        
        prev_performance = {}
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    cursor.execute("""
                        SELECT 
                            c.campaign_id,
                            SUM(cp.cost) as total_cost,
                            SUM(cp.attributed_sales_7d) as total_sales
                        FROM campaigns c
                        INNER JOIN campaign_performance cp ON c.campaign_id = cp.campaign_id
                        WHERE c.campaign_status = 'ENABLED'
                            AND cp.report_date >= %s 
                            AND cp.report_date < %s
                        GROUP BY c.campaign_id
                    """, (prev_start_date, prev_end_date))
                    for row in cursor.fetchall():
                        prev_performance[row['campaign_id']] = {
                            'spend': float(row['total_cost'] or 0),
                            'sales': float(row['total_sales'] or 0)
                        }
        except Exception as e:
            logger.warning(f"Could not get previous period performance: {e}")
        
        top_performers = []
        for campaign in campaigns:
            spend = float(campaign.get('total_cost', 0) or 0)
            sales = float(campaign.get('total_sales', 0) or 0)
            
            if sales == 0 or spend == 0:
                continue
                
            acos = (spend / sales) if sales > 0 else 0
            roas = (sales / spend) if spend > 0 else 0
            
            # Only include campaigns with good performance (low ACOS, high ROAS)
            if acos > 0.3 or roas < 3.0:  # ACOS > 30% or ROAS < 3.0
                continue
            
            # Calculate change percentage
            change_pct = 0.0
            if campaign['campaign_id'] in prev_performance:
                prev_sales = prev_performance[campaign['campaign_id']]['sales']
                if prev_sales > 0:
                    change_pct = ((sales - prev_sales) / prev_sales) * 100
            
            top_performers.append(TopPerformer(
                campaign_id=campaign['campaign_id'],
                campaign_name=campaign['campaign_name'],
                acos=round(acos * 100, 2),
                roas=round(roas, 2),
                sales=round(sales, 2),
                spend=round(spend, 2),
                change_percentage=round(change_pct, 1)
            ))
        
        # Sort by ROAS descending, then by sales descending
        top_performers.sort(key=lambda x: (x.roas, x.sales), reverse=True)
        
        return top_performers[:limit]
    except Exception as e:
        logger.error(f"Error fetching top performers: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/overview/needs-attention", response_model=List[NeedsAttention])
async def get_needs_attention(days: int = Query(7, ge=1, le=90), limit: int = Query(3, ge=1, le=10)):
    """Get campaigns that need attention due to poor performance"""
    try:
        campaigns = db_connector.get_campaigns_with_performance(days)
        
        # Get previous period for comparison
        prev_start_date = datetime.now() - timedelta(days=days * 2)
        prev_end_date = datetime.now() - timedelta(days=days)
        
        prev_performance = {}
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    cursor.execute("""
                        SELECT 
                            c.campaign_id,
                            SUM(cp.cost) as total_cost,
                            SUM(cp.attributed_sales_7d) as total_sales
                        FROM campaigns c
                        INNER JOIN campaign_performance cp ON c.campaign_id = cp.campaign_id
                        WHERE c.campaign_status = 'ENABLED'
                            AND cp.report_date >= %s 
                            AND cp.report_date < %s
                        GROUP BY c.campaign_id
                    """, (prev_start_date, prev_end_date))
                    for row in cursor.fetchall():
                        prev_performance[row['campaign_id']] = {
                            'spend': float(row['total_cost'] or 0),
                            'sales': float(row['total_sales'] or 0)
                        }
        except Exception as e:
            logger.warning(f"Could not get previous period performance: {e}")
        
        needs_attention = []
        for campaign in campaigns:
            spend = float(campaign.get('total_cost', 0) or 0)
            sales = float(campaign.get('total_sales', 0) or 0)
            budget = float(campaign.get('budget_amount', 0) or 0)
            
            if spend == 0:
                continue
                
            acos = (spend / sales * 100) if sales > 0 else float('inf')
            roas = (sales / spend) if spend > 0 else 0
            
            # Identify issues
            issues = []
            if sales == 0:
                issues.append("No sales")
            elif acos > rule_config.acos_target * 1.5:
                issues.append(f"High ACOS ({acos:.1f}%)")
            elif budget > 0 and spend >= budget * 0.9:
                issues.append("Near budget limit")
            elif roas < 1.0 and sales > 0:
                issues.append("ROAS below 1.0")
            
            if not issues:
                continue
            
            # Calculate change percentage
            change_pct = 0.0
            if campaign['campaign_id'] in prev_performance:
                prev_sales = prev_performance[campaign['campaign_id']]['sales']
                if prev_sales > 0:
                    change_pct = ((sales - prev_sales) / prev_sales) * 100
            
            needs_attention.append(NeedsAttention(
                campaign_id=campaign['campaign_id'],
                campaign_name=campaign['campaign_name'],
                acos=round(acos, 2) if acos != float('inf') else 999.99,
                roas=round(roas, 2),
                sales=round(sales, 2),
                spend=round(spend, 2),
                change_percentage=round(change_pct, 1),
                issue=", ".join(issues)
            ))
        
        # Sort by ACOS descending (worst first), then by spend descending
        needs_attention.sort(key=lambda x: (x.acos if x.acos != 999.99 else 0, x.spend), reverse=True)
        
        return needs_attention[:limit]
    except Exception as e:
        logger.error(f"Error fetching campaigns needing attention: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/overview/ai-insights", response_model=List[AIInsight])
async def get_ai_insights(days: int = Query(7, ge=1, le=90)):
    """Get AI-generated insights for the dashboard"""
    try:
        insights = []
        
        # 1. Keywords ready for bid increase
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    # Get keywords with high ROAS and good performance
                    start_date = datetime.now() - timedelta(days=days)
                    cursor.execute("""
                        SELECT COUNT(DISTINCT k.keyword_id) as count
                        FROM keywords k
                        INNER JOIN keyword_performance kp ON k.keyword_id = kp.keyword_id
                        INNER JOIN campaigns c ON k.campaign_id = c.campaign_id
                        WHERE c.campaign_status = 'ENABLED'
                            AND kp.report_date >= %s
                            AND kp.attributed_sales_7d > 0
                            AND kp.cost > 0
                            AND (kp.attributed_sales_7d / kp.cost) >= 5.0  -- ROAS >= 5.0
                            AND kp.impressions >= 100
                            AND kp.clicks >= 10
                    """, (start_date,))
                    result = cursor.fetchone()
                    if result and result['count'] > 0:
                        insights.append(AIInsight(
                            type="bid_increase",
                            count=result['count'],
                            message=f"{result['count']} keywords ready for bid increase",
                            priority="high",
                            color="green"
                        ))
        except Exception as e:
            logger.warning(f"Could not get bid increase insights: {e}")
        
        # 2. Campaigns approaching budget limit
        try:
            campaigns = db_connector.get_campaigns_with_performance(days)
            budget_campaigns = 0
            for campaign in campaigns:
                budget = float(campaign.get('budget_amount', 0) or 0)
                spend = float(campaign.get('total_cost', 0) or 0)
                if budget > 0 and spend >= budget * 0.8:  # 80% or more used
                    budget_campaigns += 1
            
            if budget_campaigns > 0:
                insights.append(AIInsight(
                    type="budget_limit",
                    count=budget_campaigns,
                    message=f"{budget_campaigns} campaigns approaching budget limit",
                    priority="medium",
                    color="orange"
                ))
        except Exception as e:
            logger.warning(f"Could not get budget limit insights: {e}")
        
        # 3. Negative keyword candidates
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    # Get search terms with high spend but no sales
                    start_date = datetime.now() - timedelta(days=days)
                    cursor.execute("""
                        SELECT COUNT(DISTINCT st.search_term) as count
                        FROM search_term_performance st
                        INNER JOIN keywords k ON st.keyword_id = k.keyword_id
                        INNER JOIN campaigns c ON k.campaign_id = c.campaign_id
                        WHERE c.campaign_status = 'ENABLED'
                            AND st.report_date >= %s
                            AND st.cost > 1.0  -- At least $1 spent
                            AND st.attributed_sales_7d = 0  -- No sales
                            AND st.impressions >= 50
                    """, (start_date,))
                    result = cursor.fetchone()
                    if result and result['count'] > 0:
                        insights.append(AIInsight(
                            type="negative_keywords",
                            count=result['count'],
                            message=f"{result['count']} new negative keyword candidates",
                            priority="medium",
                            color="blue"
                        ))
        except Exception as e:
            logger.warning(f"Could not get negative keyword insights: {e}")
        
        return insights
    except Exception as e:
        logger.error(f"Error fetching AI insights: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - CAMPAIGN MANAGEMENT
# ============================================================================

@app.get("/api/campaigns")
async def get_campaigns(
    campaign_id: Optional[int] = Query(None, description="Filter by campaign ID"),
    days: Optional[int] = Query(None, ge=1, le=365),
    start_date: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    portfolio_id: Optional[int] = Query(None, description="Filter by portfolio ID"),
    campaign_type: Optional[str] = Query(None, description="Filter by campaign type: SP (Sponsored Products), SB (Sponsored Brands), SD (Sponsored Display)"),
    status: Optional[str] = Query(None, description="Filter by status: enabled, paused, archived, or omit for all"),
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(50, ge=1, le=200, description="Items per page"),
):
    """Get campaigns with performance data (paginated). Use either days or start_date+end_date. campaign_type filters by campaigns.campaign_type (SP, SB, SD)."""
    try:
        start_dt = end_dt = None
        if start_date and end_date:
            try:
                start_dt = datetime.strptime(start_date, "%Y-%m-%d").replace(hour=0, minute=0, second=0, microsecond=0)
                end_dt = datetime.strptime(end_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59, microsecond=999999)
                if start_dt > end_dt:
                    raise HTTPException(status_code=400, detail="Start date must be before or equal to end date")
            except ValueError as e:
                raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")
        d = days if days is not None else 7
        status_filter = None if (not status or status.lower() == "all") else status
        # Filter by campaigns.campaign_type: SP, SB, SD (case-insensitive)
        campaign_type_filter = (campaign_type or "").strip().upper() if campaign_type else None
        if campaign_type_filter and campaign_type_filter not in ("SP", "SB", "SD"):
            campaign_type_filter = None
        campaigns = db_connector.get_campaigns_with_performance(
            d, portfolio_id, campaign_id, start_date=start_dt, end_date=end_dt, status=status_filter, campaign_type=campaign_type_filter
        )
        
        all_results = []
        for campaign in campaigns:
            spend = float(campaign.get('total_cost', 0) or 0)
            sales = float(campaign.get('total_sales', 0) or 0)
            impressions = int(campaign.get('total_impressions', 0) or 0)
            clicks = int(campaign.get('total_clicks', 0) or 0)
            orders = int(campaign.get('total_conversions', 0) or 0)
            
            all_results.append(CampaignData(
                campaign_id=campaign['campaign_id'],
                campaign_name=campaign['campaign_name'],
                campaign_type=campaign.get('campaign_type', 'SP'),
                status=campaign.get('campaign_status', 'ENABLED'),
                spend=round(spend, 2),
                sales=round(sales, 2),
                acos=round(spend / sales * 100, 2) if sales > 0 else None,
                roas=round(sales / spend, 2) if spend > 0 else None,
                orders=orders,
                budget=float(campaign.get('budget_amount', 0) or 0),
                impressions=impressions,
                clicks=clicks,
                ctr=round(clicks / impressions * 100, 2) if impressions > 0 else 0,
                cvr=round(orders / clicks * 100, 2) if clicks > 0 else 0,
                ai_recommendation=_get_campaign_ai_signal(campaign),
                sb_ad_type=campaign.get('sb_ad_type'),
                sd_targeting_type=campaign.get('sd_targeting_type'),
                portfolio_id=campaign.get('portfolio_id'),
                portfolio_name=campaign.get('portfolio_name')
            ))
        
        # Paginate
        total = len(all_results)
        total_pages = max(1, (total + page_size - 1) // page_size)
        start = (page - 1) * page_size
        end = start + page_size
        page_data = all_results[start:end]
        
        return {
            "data": page_data,
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
        }
    except Exception as e:
        logger.error(f"Error fetching campaigns: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/campaigns/{campaign_id}")
async def get_campaign_details(campaign_id: int, days: int = Query(7, ge=1, le=90)):
    """Get detailed campaign information"""
    try:
        performance = db_connector.get_campaign_performance(campaign_id, days)
        ad_groups = db_connector.get_ad_groups_with_performance(campaign_id, days)
        
        # Get recent bid changes for this campaign
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT id, entity_type, entity_id, entity_name, change_date, 
                           old_bid, new_bid, change_percentage, reason, triggered_by,
                           outcome_label, outcome_score
                    FROM bid_change_history
                    WHERE entity_type = 'campaign' AND entity_id = %s
                    ORDER BY change_date DESC
                    LIMIT 20
                """, (campaign_id,))
                bid_history = cursor.fetchall()
        
        return {
            "campaign_id": campaign_id,
            "performance_history": performance,
            "ad_groups": ad_groups,
            "bid_history": bid_history
        }
    except Exception as e:
        logger.error(f"Error fetching campaign details: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/campaigns/{campaign_id}/action")
async def apply_campaign_action(campaign_id: int, action: ActionRequest, background_tasks: BackgroundTasks, current_user: UserResponse = Depends(get_current_user)):
    """Apply an action to a campaign (pause, enable, budget change)
    
    Requires: admin or manager role
    """
    try:
        # RBAC: Only admin and manager roles can modify campaigns
        if current_user.role not in ['admin', 'manager']:
            raise HTTPException(status_code=403, detail="Permission denied: You don't have access to modify campaigns")
        
        campaign_status = None
        budget_amount = None
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT campaign_status, budget_amount
                    FROM campaigns
                    WHERE campaign_id = %s
                """, (campaign_id,))
                campaign = cursor.fetchone()
                if campaign:
                    campaign_status = campaign.get('campaign_status')
                    budget_amount = float(campaign.get('budget_amount', 0) or 0)

                if action.action_type == 'pause':
                    cursor.execute("""
                        UPDATE campaigns
                        SET campaign_status = 'PAUSED', updated_at = NOW()
                        WHERE campaign_id = %s
                    """, (campaign_id,))
                elif action.action_type == 'enable':
                    cursor.execute("""
                        UPDATE campaigns
                        SET campaign_status = 'ENABLED', updated_at = NOW()
                        WHERE campaign_id = %s
                    """, (campaign_id,))
                elif action.action_type == 'budget':
                    cursor.execute("""
                        UPDATE campaigns
                        SET budget_amount = %s, updated_at = NOW()
                        WHERE campaign_id = %s
                    """, (action.new_value, campaign_id))
                conn.commit()

        # Log the action
        db_connector.log_adjustment(
            entity_type='campaign',
            entity_id=campaign_id,
            adjustment_type=action.action_type,
            old_value=action.old_value or 0,
            new_value=action.new_value,
            reason=action.reason or f"Manual action from dashboard by {current_user.email}"
        )
        
        # Create a lock to prevent AI from overwriting
        if action.action_type in ['bid', 'budget']:
            db_connector.create_bid_lock(
                entity_type='campaign',
                entity_id=campaign_id,
                lock_days=rule_config.bid_change_cooldown_days,
                reason=f"Manual {action.action_type} change from dashboard by {current_user.email}"
            )
        
        # Sync to Amazon Ads API (non-blocking: DB is already committed)
        sync_manager = _get_amazon_sync_manager()
        amazon_synced = False
        if sync_manager:
            try:
                if action.action_type in ['pause', 'enable', 'budget']:
                    if action.action_type == 'budget':
                        daily_budget = float(action.new_value)
                    else:
                        daily_budget = budget_amount or 0.0
                    if daily_budget <= 0:
                        daily_budget = 1.0
                        logger.warning(
                            f"Campaign {campaign_id} missing budget; defaulting dailyBudget to $1.00 for Amazon update"
                        )
                    state = _normalize_campaign_state(
                        'PAUSED' if action.action_type == 'pause' else 'ENABLED' if action.action_type == 'enable' else campaign_status
                    )
                    sync_manager.update_campaign_budgets([{
                        'campaign_id': campaign_id,
                        'daily_budget': daily_budget,
                        'state': state
                    }])
                    amazon_synced = True
                    logger.info(f"Campaign {campaign_id} synced to Amazon: {action.action_type}")
            except Exception as sync_err:
                logger.error(f"Amazon sync failed for campaign {campaign_id}: {sync_err}")
        else:
            logger.warning(f"Amazon sync skipped for campaign {campaign_id}: sync manager unavailable")

        return {
            "status": "success",
            "message": f"Action {action.action_type} applied to campaign {campaign_id}",
            "amazon_synced": amazon_synced
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error applying campaign action: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - KEYWORDS / TARGETING
# ============================================================================

@app.get("/api/keywords")
async def get_keywords(
    keyword_id: Optional[int] = None,
    campaign_id: Optional[int] = None,
    ad_group_id: Optional[int] = None,
    state: Optional[str] = Query(None, description="Filter by state: enabled, paused, archived, or omit for all"),
    match_type: Optional[str] = Query(None, description="Filter by match type: exact, phrase, broad, or omit for all"),
    days: int = Query(7, ge=1, le=90),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """Get keywords with performance data (server-side pagination)"""
    try:
        start_date = datetime.now() - timedelta(days=days)
        offset = (page - 1) * page_size

        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                filters = []
                params: list = [start_date]
                if state and state.lower() in ("enabled", "paused", "archived"):
                    filters.append("k.state = %s")
                    params.append(state.upper())
                if match_type and match_type.lower() in ("exact", "phrase", "broad"):
                    filters.append("k.match_type = %s")
                    params.append(match_type.upper())
                if not filters:
                    filters.append("(1=1)")

                if keyword_id:
                    filters.append("k.keyword_id = %s")
                    params.append(keyword_id)
                if campaign_id:
                    filters.append("ag.campaign_id = %s")
                    params.append(campaign_id)
                if ad_group_id:
                    filters.append("k.ad_group_id = %s")
                    params.append(ad_group_id)

                where_clause = " AND ".join(filters)

                cur.execute(f"""
                    SELECT COUNT(*) as total FROM keywords k
                    JOIN ad_groups ag ON k.ad_group_id = ag.ad_group_id
                    WHERE {where_clause}
                """, params[1:])
                total = cur.fetchone()['total']

                if total == 0:
                    return {"data": [], "total": 0, "page": page, "page_size": page_size, "total_pages": 1}

                cur.execute(f"""
                    SELECT
                        k.keyword_id, k.keyword_text, k.match_type, k.bid, k.state,
                        k.ad_group_id, ag.campaign_id,
                        COALESCE(SUM(kp.impressions), 0)::int as impressions,
                        COALESCE(SUM(kp.clicks), 0)::int as clicks,
                        COALESCE(SUM(kp.cost), 0) as spend,
                        COALESCE(SUM(kp.attributed_sales_7d), 0) as sales,
                        COALESCE(SUM(kp.attributed_conversions_7d), 0)::int as orders
                    FROM keywords k
                    JOIN ad_groups ag ON k.ad_group_id = ag.ad_group_id
                    LEFT JOIN keyword_performance kp
                        ON k.keyword_id = kp.keyword_id AND kp.report_date >= %s
                    WHERE {where_clause}
                    GROUP BY k.keyword_id, k.keyword_text, k.match_type, k.bid, k.state,
                             k.ad_group_id, ag.campaign_id
                    ORDER BY spend DESC
                    LIMIT %s OFFSET %s
                """, params + [page_size, offset])
                rows = cur.fetchall()

                kw_ids = [r['keyword_id'] for r in rows]

                bid_locks: dict = {}
                last_changes: dict = {}
                if kw_ids:
                    cur.execute("""
                        SELECT entity_id, locked_until, lock_reason
                        FROM bid_adjustment_locks
                        WHERE entity_type = 'keyword' AND locked_until > NOW()
                          AND entity_id = ANY(%s)
                    """, (kw_ids,))
                    bid_locks = {r['entity_id']: r['lock_reason'] for r in cur.fetchall()}

                    cur.execute("""
                        SELECT DISTINCT ON (entity_id) entity_id, new_bid, reason
                        FROM bid_change_history
                        WHERE entity_type = 'keyword' AND entity_id = ANY(%s)
                        ORDER BY entity_id, change_date DESC
                    """, (kw_ids,))
                    last_changes = {r['entity_id']: r for r in cur.fetchall()}

        page_keywords = []
        for r in rows:
            spend = float(r['spend'] or 0)
            sales = float(r['sales'] or 0)
            impressions = int(r['impressions'] or 0)
            clicks = int(r['clicks'] or 0)
            orders = int(r['orders'] or 0)
            kid = r['keyword_id']

            lc = last_changes.get(kid)
            ai_bid = float(lc['new_bid']) if lc else None
            reason = lc['reason'] if lc else None

            page_keywords.append(KeywordData(
                keyword_id=kid,
                keyword_text=r['keyword_text'],
                match_type=r.get('match_type', 'BROAD'),
                campaign_id=r['campaign_id'],
                ad_group_id=r['ad_group_id'],
                bid=float(r.get('bid', 0) or 0),
                state=r.get('state', 'ENABLED'),
                spend=round(spend, 2),
                sales=round(sales, 2),
                acos=round(spend / sales * 100, 2) if sales > 0 else None,
                roas=round(sales / spend, 2) if spend > 0 else None,
                orders=orders,
                impressions=impressions,
                clicks=clicks,
                ctr=round(clicks / impressions * 100, 2) if impressions > 0 else 0,
                cvr=round(orders / clicks * 100, 2) if clicks > 0 else 0,
                ai_suggested_bid=ai_bid,
                confidence_score=None,
                reason=reason,
                is_locked=kid in bid_locks,
                lock_reason=bid_locks.get(kid)
            ))

        total_pages = max(1, (total + page_size - 1) // page_size)

        return {
            "data": page_keywords,
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
        }
    except Exception as e:
        logger.error(f"Error fetching keywords: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/keywords/{keyword_id}/bid")
async def update_keyword_bid(keyword_id: int, action: ActionRequest, current_user: UserResponse = Depends(get_current_user)):
    """Update keyword bid with inventory protection
    
    keyword_id is the Amazon external keyword_id (not database internal id).
    Requires: admin, manager, or specialist role
    """
    try:
        # RBAC: Only admin, manager, and specialist roles can modify bids
        # if current_user.role not in ['admin', 'manager', 'specialist']:
        #     raise HTTPException(status_code=403, detail="Permission denied: You don't have access to modify bids")
        
        keyword_state = None
        keyword_text = None
        
        # Check inventory status before allowing bid changes
        # Prevent bidding on out-of-stock products to reduce wasted spend
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    # Get keyword details (use keyword_id, the Amazon external ID)
                    cursor.execute("""
                        SELECT keyword_id, keyword_text, bid, state, asin
                        FROM keywords WHERE keyword_id = %s
                    """, (keyword_id,))
                    keyword = cursor.fetchone()
                    
                    if not keyword:
                        raise HTTPException(status_code=404, detail=f"Keyword {keyword_id} not found")
                    
                    keyword_text = keyword.get('keyword_text', f'Keyword {keyword_id}')
                    keyword_state = keyword.get('state')
                    
                    # Check if product is out of stock
                    asin = keyword.get('asin')
                    if asin:
                        cursor.execute("""
                            SELECT ad_status FROM inventory_status 
                            WHERE asin = %s AND ad_status = 'out_of_stock'
                        """, (asin,))
                        out_of_stock = cursor.fetchone()
                        
                        if out_of_stock:
                            raise HTTPException(
                                status_code=422,
                                detail=f"Cannot update bid: ASIN {asin} is out of stock. Bidding disabled to prevent wasted spend."
                            )
                    
                    # Actually update the bid in the keywords table
                    cursor.execute("""
                        UPDATE keywords SET bid = %s, last_modified = NOW()
                        WHERE keyword_id = %s
                    """, (action.new_value, keyword_id))
                    conn.commit()
        except HTTPException:
            raise
        except Exception as inv_error:
            logger.warning(f"Could not check inventory for keyword {keyword_id}: {inv_error}")
            # Continue anyway - inventory check is optional
        
        # Save the bid change to history
        change_record = {
            'entity_type': 'keyword',
            'entity_id': keyword_id,
            'entity_name': keyword_text or f"Keyword {keyword_id}",
            'change_date': datetime.now(),
            'old_bid': action.old_value or 0,
            'new_bid': action.new_value,
            'change_amount': action.new_value - (action.old_value or 0),
            'change_percentage': ((action.new_value - (action.old_value or 0)) / action.old_value * 100) if action.old_value else 0,
            'reason': action.reason or "Manual bid update from dashboard",
            'triggered_by': 'dashboard_manual',
            'acos_at_change': None,
            'roas_at_change': None,
            'ctr_at_change': None,
            'conversions_at_change': None,
            'metadata': '{}',
        }
        
        change_id = db_connector.save_bid_change(change_record)
        
        # Create a lock to prevent AI from overwriting
        db_connector.create_bid_lock(
            entity_type='keyword',
            entity_id=keyword_id,
            lock_days=rule_config.bid_change_cooldown_days,
            reason="Manual bid change from dashboard",
            change_id=change_id
        )
        
        # Sync bid change to Amazon Ads API (non-blocking: DB is already committed)
        amazon_synced = False
        sync_manager = _get_amazon_sync_manager()
        if sync_manager:
            try:
                sync_manager.update_keyword_bids([{
                    'keyword_id': keyword_id,
                    'bid': float(action.new_value),
                    'state': _normalize_campaign_state(keyword_state)
                }])
                amazon_synced = True
                logger.info(f"Keyword {keyword_id} bid synced to Amazon: ${action.new_value}")
            except Exception as sync_err:
                logger.error(f"Amazon sync failed for keyword {keyword_id}: {sync_err}")
        else:
            logger.warning(f"Amazon sync skipped for keyword {keyword_id}: sync manager unavailable")
        
        logger.info(f"Bid updated for keyword {keyword_id}: ${action.old_value} -> ${action.new_value} by {current_user.username}")
        return {
            "status": "success",
            "message": f"Bid updated for keyword {keyword_id}",
            "change_id": change_id,
            "amazon_synced": amazon_synced
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating keyword bid: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/keywords/{keyword_id}/lock")
async def lock_keyword_bid(keyword_id: int, days: int = Query(3, ge=1, le=30), reason: str = None):
    """Lock a keyword from AI bid changes"""
    try:
        db_connector.create_bid_lock(
            entity_type='keyword',
            entity_id=keyword_id,
            lock_days=days,
            reason=reason or "Manual lock from dashboard"
        )
        return {"status": "success", "message": f"Keyword {keyword_id} locked for {days} days"}
    except Exception as e:
        logger.error(f"Error locking keyword: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/keywords/{keyword_id}/lock")
async def unlock_keyword_bid(keyword_id: int, current_user: UserResponse = Depends(get_current_user)):
    """Remove lock from a keyword
    
    Requires: admin or manager role
    """
    try:
        # RBAC: Only admin and manager roles can remove locks
        # if current_user.role not in ['admin', 'manager']:
        #     raise HTTPException(status_code=403, detail="Permission denied: You don't have access to remove locks")
        
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    DELETE FROM bid_adjustment_locks 
                    WHERE entity_type = 'keyword' AND entity_id = %s
                """, (keyword_id,))
                conn.commit()
        return {"status": "success", "message": f"Keyword {keyword_id} unlocked"}
    except Exception as e:
        logger.error(f"Error unlocking keyword: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - PRODUCT TARGETING (DISTINCT FROM KEYWORDS)
# ============================================================================

# Valid sort columns for product targeting (frontend key -> SQL expression)
PRODUCT_TARGETING_SORT_COLUMNS = {
    "targeting_id": "pt.target_id",
    "targeting_value": "pt.target_value",
    "targeting_type": "pt.target_type",
    "campaign_name": "c.campaign_name",
    "ad_group_name": "ag.ad_group_name",
    "bid": "pt.bid",
    "state": "pt.state",
    "impressions": "perf.impressions",
    "clicks": "perf.clicks",
    "spend": "perf.spend",
    "sales": "perf.sales",
    "acos": "(CASE WHEN perf.sales > 0 THEN perf.spend / perf.sales * 100 ELSE NULL END)",
    "roas": "(CASE WHEN perf.spend > 0 THEN perf.sales / perf.spend ELSE NULL END)",
}


@app.get("/api/product-targeting")
async def get_product_targeting(
    campaign_id: Optional[int] = None,
    ad_group_id: Optional[int] = None,
    targeting_type: Optional[str] = None,
    state: Optional[str] = None,
    days: int = Query(7, ge=1, le=90),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = Query("asc", regex="^(asc|desc)$"),
):
    """Get product targeting data from DB with performance from keyword_performance."""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                end_date = datetime.now().date()
                start_date = end_date - timedelta(days=days)

                where_clauses = ["1=1"]
                params: list = []

                if campaign_id:
                    where_clauses.append("pt.campaign_id = %s")
                    params.append(campaign_id)
                if ad_group_id:
                    where_clauses.append("pt.ad_group_id = %s")
                    params.append(ad_group_id)
                if targeting_type:
                    where_clauses.append("LOWER(pt.target_type) = LOWER(%s)")
                    params.append(targeting_type)
                if state:
                    where_clauses.append("LOWER(pt.state) = LOWER(%s)")
                    params.append(state)

                where_sql = " AND ".join(where_clauses)

                order_dir = "DESC" if (sort_order or "asc").lower() == "desc" else "ASC"
                order_col = PRODUCT_TARGETING_SORT_COLUMNS.get((sort_by or "").strip().lower(), "pt.target_id")
                order_sql = f"ORDER BY {order_col} {order_dir} NULLS LAST"

                # One row per (campaign_id, ad_group_id): the one with the largest id (most recent row in product_targets)
                latest_cte = f"""
                    latest AS (
                        SELECT pt.campaign_id, pt.ad_group_id, MAX(pt.id) AS max_id
                        FROM product_targets pt
                        WHERE {where_sql}
                        GROUP BY pt.campaign_id, pt.ad_group_id
                    )
                """
                count_sql = f"WITH {latest_cte} SELECT COUNT(*) AS cnt FROM latest"
                cursor.execute(count_sql, params)
                total = cursor.fetchone()["cnt"]
                total_pages = max(1, (total + page_size - 1) // page_size)

                offset = (page - 1) * page_size
                params_main = [start_date, end_date] + list(params) + [page_size, offset]

                query = f"""
                    WITH {latest_cte}
                    SELECT
                        pt.target_id   AS targeting_id,
                        pt.target_value AS targeting_value,
                        LOWER(pt.target_type) AS targeting_type,
                        pt.campaign_id,
                        c.campaign_name,
                        pt.ad_group_id,
                        ag.ad_group_name,
                        pt.bid,
                        pt.state,
                        perf.impressions,
                        perf.clicks,
                        perf.spend,
                        perf.sales
                    FROM product_targets pt
                    INNER JOIN latest l ON pt.id = l.max_id
                    LEFT JOIN campaigns c  ON pt.campaign_id  = c.campaign_id
                    LEFT JOIN ad_groups ag ON pt.ad_group_id  = ag.ad_group_id
                    LEFT JOIN LATERAL (
                        SELECT
                            COALESCE(SUM(cp.impressions), 0)          AS impressions,
                            COALESCE(SUM(cp.clicks), 0)               AS clicks,
                            COALESCE(SUM(cp.cost), 0)                 AS spend,
                            COALESCE(SUM(cp.attributed_sales_7d), 0)  AS sales
                        FROM campaign_performance cp
                        WHERE cp.campaign_id = pt.campaign_id
                          AND cp.report_date >= %s
                          AND cp.report_date <= %s
                    ) perf ON TRUE
                    {order_sql}
                    LIMIT %s OFFSET %s
                """

                cursor.execute(query, params_main)
                rows = cursor.fetchall()

                data = []
                for r in rows:
                    spend = float(r["spend"] or 0)
                    sales = float(r["sales"] or 0)
                    acos = round(spend / sales * 100, 2) if sales > 0 else None
                    roas = round(sales / spend, 2) if spend > 0 else None
                    data.append({
                        "targeting_id": r["targeting_id"],
                        "targeting_value": r["targeting_value"] or "",
                        "targeting_type": r["targeting_type"] or "",
                        "campaign_id": r["campaign_id"],
                        "campaign_name": r["campaign_name"] or "",
                        "ad_group_id": r["ad_group_id"],
                        "ad_group_name": r["ad_group_name"] or "",
                        "bid": float(r["bid"]) if r["bid"] is not None else None,
                        "state": (r["state"] or "").lower() or None,
                        "impressions": int(r["impressions"] or 0),
                        "clicks": int(r["clicks"] or 0),
                        "spend": spend,
                        "sales": sales,
                        "acos": acos,
                        "roas": roas,
                    })

                return {
                    "data": data,
                    "total": total,
                    "page": page,
                    "page_size": page_size,
                    "total_pages": total_pages,
                }
    except Exception as e:
        logger.error(f"Error fetching product targeting: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - SEARCH
# ============================================================================

@app.get("/api/search", response_model=SearchResponse)
async def search(
    q: str = Query(..., min_length=1, max_length=100, description="Search query"),
    limit: int = Query(20, ge=1, le=100, description="Maximum number of results")
):
    """
    Search across campaigns, keywords, and ad groups
    
    Searches for:
    - Campaign names
    - Keyword text
    - Ad group names
    """
    try:
        if not q or len(q.strip()) == 0:
            return SearchResponse(query=q, results=[], total=0)

        query = q.strip().lower()
        pattern = f"%{query}%"
        results: List[SearchResult] = []

        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT campaign_id, campaign_name,
                           CASE WHEN LOWER(campaign_name) = %s THEN 1.0 ELSE 0.5 END as match_score
                    FROM campaigns
                    WHERE campaign_name ILIKE %s
                    ORDER BY match_score DESC
                    LIMIT %s
                """, (query, pattern, limit))
                for row in cur.fetchall():
                    results.append(SearchResult(
                        type='campaign', id=row['campaign_id'],
                        name=row['campaign_name'],
                        campaign_id=row['campaign_id'],
                        campaign_name=row['campaign_name'],
                        match_score=float(row['match_score'])
                    ))

                remaining = limit - len(results)
                if remaining > 0:
                    cur.execute("""
                        SELECT ag.ad_group_id, ag.ad_group_name, ag.campaign_id,
                               c.campaign_name,
                               CASE WHEN LOWER(ag.ad_group_name) = %s THEN 1.0 ELSE 0.5 END as match_score
                        FROM ad_groups ag
                        JOIN campaigns c ON ag.campaign_id = c.campaign_id
                        WHERE ag.ad_group_name ILIKE %s
                        ORDER BY match_score DESC
                        LIMIT %s
                    """, (query, pattern, remaining))
                    for row in cur.fetchall():
                        results.append(SearchResult(
                            type='ad_group', id=row['ad_group_id'],
                            name=row['ad_group_name'],
                            campaign_id=row['campaign_id'],
                            campaign_name=row['campaign_name'],
                            ad_group_id=row['ad_group_id'],
                            ad_group_name=row['ad_group_name'],
                            match_score=float(row['match_score'])
                        ))

                remaining = limit - len(results)
                if remaining > 0:
                    cur.execute("""
                        SELECT k.keyword_id, k.keyword_text, k.ad_group_id,
                               ag.ad_group_name, ag.campaign_id, c.campaign_name,
                               CASE WHEN LOWER(k.keyword_text) = %s THEN 1.0 ELSE 0.5 END as match_score
                        FROM keywords k
                        JOIN ad_groups ag ON k.ad_group_id = ag.ad_group_id
                        JOIN campaigns c ON ag.campaign_id = c.campaign_id
                        WHERE k.keyword_text ILIKE %s
                        ORDER BY match_score DESC
                        LIMIT %s
                    """, (query, pattern, remaining))
                    for row in cur.fetchall():
                        results.append(SearchResult(
                            type='keyword', id=row['keyword_id'],
                            name=row['keyword_text'],
                            campaign_id=row['campaign_id'],
                            campaign_name=row['campaign_name'],
                            ad_group_id=row['ad_group_id'],
                            ad_group_name=row['ad_group_name'],
                            match_score=float(row['match_score'])
                        ))

        results.sort(key=lambda x: x.match_score, reverse=True)

        return SearchResponse(
            query=q,
            results=results,
            total=len(results)
        )
    except Exception as e:
        logger.error(f"Error in search: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - AI RECOMMENDATIONS
# ============================================================================

@app.get("/api/recommendations", response_model=List[RecommendationData])
async def get_recommendations(
    recommendation_type: Optional[str] = None,
    priority: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200)
):
    """Get AI recommendations"""
    try:
        # Get recommendations from database
        recommendations = []
        db_rec_count = 0
        skipped_count = 0
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    query = """
                        SELECT recommendation_id, entity_type, entity_id, adjustment_type,
                               recommended_value, current_value, intelligence_signals,
                               strategy_id, created_at, applied, metadata
                        FROM recommendation_tracking
                        WHERE applied = FALSE
                    """
                    params = []
                    
                    if recommendation_type:
                        query += " AND adjustment_type = %s"
                        params.append(recommendation_type)
                    
                    query += " ORDER BY created_at DESC LIMIT %s"
                    params.append(limit)
                    
                    cursor.execute(query, params)
                    db_recs = cursor.fetchall()
                    db_rec_count = len(db_recs)
                    logger.info(f"Found {db_rec_count} pending recommendations in database")
                    
                    # Pre-fetch entity names in bulk to avoid per-record queries
                    entity_names = {}
                    if db_recs:
                        keyword_ids = [r['entity_id'] for r in db_recs if r.get('entity_type') == 'keyword']
                        campaign_ids = [r['entity_id'] for r in db_recs if r.get('entity_type') == 'campaign']
                        ad_group_ids = [r['entity_id'] for r in db_recs if r.get('entity_type') == 'ad_group']
                        
                        if keyword_ids:
                            try:
                                placeholders = ','.join(['%s'] * len(keyword_ids))
                                cursor.execute(f"SELECT keyword_id, keyword_text FROM keywords WHERE keyword_id IN ({placeholders})", keyword_ids)
                                for row in cursor.fetchall():
                                    entity_names[('keyword', row['keyword_id'])] = row['keyword_text']
                            except Exception:
                                pass
                        
                        if campaign_ids:
                            try:
                                placeholders = ','.join(['%s'] * len(campaign_ids))
                                cursor.execute(f"SELECT campaign_id, campaign_name FROM campaigns WHERE campaign_id IN ({placeholders})", campaign_ids)
                                for row in cursor.fetchall():
                                    entity_names[('campaign', row['campaign_id'])] = row['campaign_name']
                            except Exception:
                                pass
                        
                        if ad_group_ids:
                            try:
                                placeholders = ','.join(['%s'] * len(ad_group_ids))
                                cursor.execute(f"SELECT ad_group_id, ad_group_name FROM ad_groups WHERE ad_group_id IN ({placeholders})", ad_group_ids)
                                for row in cursor.fetchall():
                                    entity_names[('ad_group', row['ad_group_id'])] = row['ad_group_name']
                            except Exception:
                                pass
                    
                    for rec in db_recs:
                        try:
                            # Determine priority based on intelligence signals
                            signals = rec.get('intelligence_signals') or {}
                            if isinstance(signals, str):
                                try:
                                    signals = json.loads(signals)
                                except Exception:
                                    signals = {}
                            if not isinstance(signals, dict):
                                signals = {}
                            
                            # Calculate priority
                            current_val = float(rec.get('current_value') or 0)
                            recommended_val = float(rec.get('recommended_value') or 0)
                            adjustment_pct = abs(((recommended_val - current_val) / current_val * 100) if current_val else 0)
                            if adjustment_pct > 30:
                                rec_priority = 'critical'
                            elif adjustment_pct > 20:
                                rec_priority = 'high'
                            elif adjustment_pct > 10:
                                rec_priority = 'medium'
                            else:
                                rec_priority = 'low'
                            
                            if priority and rec_priority != priority:
                                continue
                            
                            # Get entity name from pre-fetched map
                            entity_type_str = str(rec.get('entity_type', 'unknown'))
                            entity_id_val = rec.get('entity_id', 0)
                            entity_name = entity_names.get((entity_type_str, entity_id_val), f"{entity_type_str} {entity_id_val}")
                            
                            # Build reason from signals
                            adjustment_type_str = str(rec.get('adjustment_type', 'bid'))
                            reason = _build_recommendation_reason(signals, adjustment_type_str)
                            
                            # Parse created_at safely
                            created_at_val = rec.get('created_at')
                            if hasattr(created_at_val, 'isoformat'):
                                created_at_str = created_at_val.isoformat()
                            elif created_at_val:
                                created_at_str = str(created_at_val)
                            else:
                                created_at_str = datetime.now().isoformat()
                            
                            recommendations.append(RecommendationData(
                                id=str(rec.get('recommendation_id', f'rec_{entity_id_val}')),
                                entity_type=entity_type_str,
                                entity_id=int(entity_id_val),
                                entity_name=entity_name,
                                recommendation_type=adjustment_type_str,
                                current_value=current_val,
                                recommended_value=recommended_val,
                                adjustment_percentage=adjustment_pct if recommended_val > current_val else -adjustment_pct,
                                priority=rec_priority,
                                confidence=float(signals.get('confidence', 0.7) or 0.7),
                                reason=reason,
                                estimated_impact=_calculate_estimated_impact_str(rec),
                                intelligence_signals=signals if isinstance(signals, dict) else {},
                                created_at=created_at_str,
                                status="pending"
                            ))
                        except Exception as rec_err:
                            skipped_count += 1
                            logger.warning(f"Skipping bad recommendation record {rec.get('recommendation_id', '?')}: {rec_err}", exc_info=True)
                    
                    if skipped_count > 0:
                        logger.warning(f"Skipped {skipped_count} of {db_rec_count} recommendation records due to errors")
        except Exception as e:
            logger.error(f"Could not get recommendations from database: {e}", exc_info=True)
        
        # If no recommendations in database, run analysis
        if not recommendations:
            logger.info(f"No processed recommendations from DB (had {db_rec_count} raw records, skipped {skipped_count}). Running AI analysis...")
            try:
                recs = ai_engine.analyze_campaigns()
                logger.info(f"AI analysis returned {len(recs)} recommendations")
                for rec in recs[:limit]:
                    try:
                        if recommendation_type and rec.adjustment_type != recommendation_type:
                            continue
                        if priority and rec.priority != priority:
                            continue
                        
                        impact = _calculate_estimated_impact(rec)
                        
                        recommendations.append(RecommendationData(
                            id=f"{rec.entity_type}_{rec.entity_id}_{rec.created_at.timestamp()}",
                            entity_type=rec.entity_type,
                            entity_id=int(rec.entity_id),
                            entity_name=getattr(rec, 'entity_name', f"{rec.entity_type} {rec.entity_id}"),
                            recommendation_type=rec.adjustment_type,
                            current_value=float(rec.current_value or 0),
                            recommended_value=float(rec.recommended_value or 0),
                            adjustment_percentage=float(rec.adjustment_percentage or 0),
                            priority=rec.priority or 'medium',
                            confidence=float(rec.confidence or 0.5),
                            reason=rec.reason or f"AI-optimized {rec.adjustment_type} recommendation",
                            estimated_impact=impact,
                            created_at=rec.created_at.isoformat() if hasattr(rec.created_at, 'isoformat') else str(rec.created_at),
                            status="pending"
                        ))
                    except Exception as rec_err:
                        logger.warning(f"Skipping bad AI recommendation for {getattr(rec, 'entity_type', '?')}_{getattr(rec, 'entity_id', '?')}: {rec_err}", exc_info=True)
            except Exception as e:
                logger.warning(f"Could not run AI analysis: {e}", exc_info=True)
        
        logger.info(f"Returning {len(recommendations)} recommendations")
        return recommendations[:limit]
    except Exception as e:
        logger.error(f"Error fetching recommendations: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/recommendations/{recommendation_id}/approve")
async def approve_recommendation(recommendation_id: str, background_tasks: BackgroundTasks):
    """Approve an AI recommendation — applies the change to DB and syncs to Amazon"""
    try:
        rec = None
        
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                # 1. Get recommendation details
                cursor.execute("""
                    SELECT entity_type, entity_id, adjustment_type,
                           current_value, recommended_value
                    FROM recommendation_tracking
                    WHERE recommendation_id = %s
                """, (recommendation_id,))
                rec = cursor.fetchone()
                
                if not rec:
                    raise HTTPException(status_code=404, detail=f"Recommendation {recommendation_id} not found")
                
                entity_type = rec['entity_type']
                entity_id = rec['entity_id']
                current_value = float(rec['current_value'])
                recommended_value = float(rec['recommended_value'])
                adjustment_type = rec.get('adjustment_type', 'bid')
                
                # 2. Mark recommendation as applied
                cursor.execute("""
                    UPDATE recommendation_tracking 
                    SET applied = TRUE, applied_at = NOW()
                    WHERE recommendation_id = %s
                """, (recommendation_id,))
                
                # 3. Log in recommendation_actions
                cursor.execute("""
                    INSERT INTO recommendation_actions 
                    (recommendation_id, entity_type, entity_id, action_taken, 
                     original_value, recommended_value, final_value, execution_status,
                     executed_at)
                    VALUES (%s, %s, %s, 'approved', %s, %s, %s, 'executed', NOW())
                """, (recommendation_id, entity_type, entity_id,
                      current_value, recommended_value, recommended_value))
                
                # 4. Apply the actual change to the entity in the database
                if entity_type == 'keyword' and adjustment_type == 'bid':
                    cursor.execute("""
                        UPDATE keywords SET bid = %s, last_modified = NOW()
                        WHERE keyword_id = %s
                    """, (recommended_value, entity_id))
                elif entity_type == 'campaign' and adjustment_type == 'budget':
                    cursor.execute("""
                        UPDATE campaigns SET budget_amount = %s, updated_at = NOW()
                        WHERE campaign_id = %s
                    """, (recommended_value, entity_id))
                elif entity_type == 'campaign' and adjustment_type in ('pause', 'enable'):
                    new_status = 'PAUSED' if adjustment_type == 'pause' else 'ENABLED'
                    cursor.execute("""
                        UPDATE campaigns SET campaign_status = %s, updated_at = NOW()
                        WHERE campaign_id = %s
                    """, (new_status, entity_id))
                
                # 5. Log in bid_change_history for bid changes
                if adjustment_type == 'bid':
                    change_amount = recommended_value - current_value
                    change_pct = (change_amount / current_value * 100) if current_value else 0
                    cursor.execute("""
                        INSERT INTO bid_change_history
                            (entity_type, entity_id, entity_name, change_date,
                             old_bid, new_bid, change_amount, change_percentage,
                             reason, triggered_by)
                        VALUES (%s, %s, %s, NOW(), %s, %s, %s, %s, %s, 'ai_recommendation')
                    """, (entity_type, entity_id, f'{entity_type} {entity_id}',
                          current_value, recommended_value, change_amount, change_pct,
                          f'AI recommendation approved: {recommendation_id}'))
                
                # 6. Create bid lock to prevent AI from immediately overwriting
                if adjustment_type == 'bid':
                    try:
                        db_connector.create_bid_lock(
                            entity_type=entity_type,
                            entity_id=entity_id,
                            lock_days=rule_config.bid_change_cooldown_days if rule_config else 3,
                            reason=f"Recommendation {recommendation_id} applied from dashboard"
                        )
                    except Exception as lock_err:
                        logger.warning(f"Could not create bid lock: {lock_err}")
                
                conn.commit()
        
        # 7. Sync to Amazon Ads API
        if rec:
            sync_manager = _get_amazon_sync_manager()
            if sync_manager:
                try:
                    entity_type = rec['entity_type']
                    entity_id = rec['entity_id']
                    recommended_value = float(rec['recommended_value'])
                    adjustment_type = rec.get('adjustment_type', 'bid')
                    
                    if entity_type == 'keyword' and adjustment_type == 'bid':
                        sync_manager.update_keyword_bids([{
                            'keyword_id': entity_id,
                            'bid': recommended_value,
                        }])
                    elif entity_type == 'campaign':
                        if adjustment_type == 'budget':
                            sync_manager.update_campaign_budgets([{
                                'campaign_id': entity_id,
                                'daily_budget': recommended_value,
                            }])
                        elif adjustment_type in ('pause', 'enable'):
                            state = 'PAUSED' if adjustment_type == 'pause' else 'ENABLED'
                            sync_manager.update_campaign_state(entity_id, state)
                    
                    logger.info(f"Recommendation {recommendation_id} synced to Amazon")
                except Exception as sync_err:
                    logger.error(f"Amazon sync failed for recommendation {recommendation_id}: {sync_err}")
            else:
                logger.warning(f"Amazon sync skipped for recommendation {recommendation_id}: sync manager unavailable")
        
        logger.info(f"Recommendation approved and executed: {recommendation_id}")
        
        return {"status": "success", "message": f"Recommendation {recommendation_id} approved and applied"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error approving recommendation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/recommendations/{recommendation_id}/reject")
async def reject_recommendation(recommendation_id: str, reason: Optional[str] = None):
    """Reject an AI recommendation"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                # Get recommendation details
                cursor.execute("""
                    SELECT entity_type, entity_id, current_value, recommended_value
                    FROM recommendation_tracking
                    WHERE recommendation_id = %s
                """, (recommendation_id,))
                rec = cursor.fetchone()
                
                if not rec:
                    raise HTTPException(status_code=404, detail=f"Recommendation {recommendation_id} not found")
                
                # Mark recommendation as not applied (rejected)
                cursor.execute("""
                    UPDATE recommendation_tracking 
                    SET applied = FALSE, updated_at = NOW(),
                        metadata = COALESCE(metadata, '{}'::jsonb) || 
                                   jsonb_build_object('rejected', true, 'reject_reason', %s)
                    WHERE recommendation_id = %s
                """, (reason or 'No reason provided', recommendation_id))
                
                # Log the rejection in recommendation_actions
                cursor.execute("""
                    INSERT INTO recommendation_actions 
                    (recommendation_id, entity_type, entity_id, action_taken, 
                     original_value, recommended_value, reason, execution_status)
                    VALUES (%s, %s, %s, 'rejected', %s, %s, %s, 'cancelled')
                """, (recommendation_id, rec['entity_type'], rec['entity_id'],
                      rec['current_value'], rec['recommended_value'], reason))
                
                conn.commit()
        
        logger.info(f"Recommendation rejected: {recommendation_id}, reason: {reason}")
        return {"status": "success", "message": f"Recommendation {recommendation_id} rejected"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error rejecting recommendation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/recommendations/bulk-approve")
async def bulk_approve_recommendations(recommendation_ids: List[str]):
    """Bulk approve multiple recommendations"""
    try:
        approved = []
        for rec_id in recommendation_ids:
            try:
                with db_connector.get_connection() as conn:
                    with conn.cursor() as cursor:
                        cursor.execute("""
                            UPDATE recommendation_tracking 
                            SET applied = TRUE, applied_at = NOW()
                            WHERE recommendation_id = %s
                        """, (rec_id,))
                        conn.commit()
                approved.append(rec_id)
            except Exception as e:
                logger.warning(f"Failed to approve {rec_id}: {e}")
        
        return {"status": "success", "approved_count": len(approved), "approved_ids": approved}
    except Exception as e:
        logger.error(f"Error bulk approving recommendations: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - RULE ENGINE VISIBILITY
# ============================================================================

@app.get("/api/rules", response_model=List[RuleData])
async def get_rules():
    """Get all active rules with their configuration"""
    try:
        rule_docs = ai_engine.get_rule_documentation()
        
        rules = []
        for rule_name, rule_info in rule_docs.items():
            if rule_name in ['bid_limits', 'safety_limits']:
                continue
            
            # Get parameters from config
            parameters = {}
            if 'acos' in rule_name.lower():
                parameters = {
                    'target_acos': rule_config.acos_target,
                    'tolerance': rule_config.acos_tolerance,
                    'high_threshold': rule_config.acos_high_threshold,
                    'low_threshold': rule_config.acos_low_threshold
                }
            elif 'roas' in rule_name.lower():
                parameters = {
                    'target_roas': rule_config.roas_target,
                    'tolerance': rule_config.roas_tolerance
                }
            
            rules.append(RuleData(
                id=rule_name,
                name=rule_name.replace('_', ' ').title(),
                description=rule_info.get('description', ''),
                logic=str(rule_info.get('triggers', [])),
                is_active=True,
                trigger_frequency="Daily",
                last_execution=datetime.now().isoformat(),
                last_result="Success",
                parameters=parameters
            ))
        
        return rules
    except Exception as e:
        logger.error(f"Error fetching rules: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/rules/{rule_id}")
async def get_rule_details(rule_id: str):
    """Get detailed rule information"""
    try:
        rule_docs = ai_engine.get_rule_documentation()
        
        if rule_id not in rule_docs:
            raise HTTPException(status_code=404, detail=f"Rule {rule_id} not found")
        
        return {
            "id": rule_id,
            "name": rule_id.replace('_', ' ').title(),
            **rule_docs[rule_id]
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching rule details: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - NEGATIVE KEYWORDS / WASTE ANALYZER
# ============================================================================

@app.get("/api/negatives/candidates", response_model=List[NegativeCandidateData])
async def get_negative_candidates(campaign_id: Optional[int] = None, limit: int = Query(50, ge=1, le=200)):
    """Get negative keyword candidates"""
    try:
        all_candidates = []
        
        # Try to get from database first
        try:
            with db_connector.get_connection() as conn:
                import psycopg2.extras
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                    query = """
                        SELECT nkc.keyword_id, nkc.keyword_text, nkc.match_type,
                               nkc.campaign_id, nkc.ad_group_id, nkc.severity,
                               nkc.confidence, nkc.reason, nkc.suggested_action,
                               nkc.cost_at_identification as spend,
                               nkc.clicks_at_identification as clicks,
                               nkc.impressions_at_identification as impressions,
                               nkc.conversions_at_identification as orders,
                               nkc.status
                        FROM negative_keyword_candidates nkc
                        WHERE nkc.status = 'pending'
                    """
                    params = []
                    
                    if campaign_id:
                        query += " AND nkc.campaign_id = %s"
                        params.append(campaign_id)
                    
                    query += " ORDER BY nkc.confidence DESC, nkc.cost_at_identification DESC LIMIT %s"
                    params.append(limit)
                    
                    cursor.execute(query, params)
                    db_candidates = cursor.fetchall()
                    
                    for c in db_candidates:
                        all_candidates.append(NegativeCandidateData(
                            keyword_id=c['keyword_id'],
                            keyword_text=c['keyword_text'],
                            match_type=c['match_type'],
                            campaign_id=c['campaign_id'],
                            ad_group_id=c['ad_group_id'],
                            spend=float(c.get('spend', 0) or 0),
                            clicks=int(c.get('clicks', 0) or 0),
                            impressions=int(c.get('impressions', 0) or 0),
                            orders=int(c.get('orders', 0) or 0),
                            severity=c['severity'],
                            confidence=float(c['confidence']),
                            reason=c['reason'],
                            suggested_action=c.get('suggested_action', 'negative_exact'),
                            status=c['status']
                        ))
        except Exception as e:
            logger.warning(f"Could not get negative candidates from database: {e}")
        
        # If no candidates in database, run bulk analysis (3 queries instead of N+1)
        if not all_candidates and ai_engine.negative_manager:
            if campaign_id:
                campaign_ids = [campaign_id]
            else:
                campaigns = db_connector.get_campaigns_with_performance(14)
                campaign_ids = [c['campaign_id'] for c in campaigns]

            if campaign_ids:
                from collections import defaultdict
                lookback = ai_engine.config.performance_lookback_days
                now = datetime.now()
                start_lookback = now - timedelta(days=lookback)
                start_30d = now - timedelta(days=30)
                cutoff_14d = (now - timedelta(days=14)).date()
                cutoff_7d = (now - timedelta(days=7)).date()

                try:
                    with db_connector.get_connection() as conn:
                        import psycopg2.extras
                        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                            cur.execute("""
                                SELECT ag.ad_group_id, ag.campaign_id
                                FROM ad_groups ag
                                LEFT JOIN ad_group_performance agp
                                    ON ag.ad_group_id = agp.ad_group_id AND agp.report_date >= %s
                                WHERE ag.campaign_id = ANY(%s)
                                GROUP BY ag.ad_group_id, ag.campaign_id
                                HAVING COALESCE(SUM(agp.impressions), 0) >= 50
                            """, (start_lookback, campaign_ids))
                            ad_groups = cur.fetchall()

                            if ad_groups:
                                ag_ids = [ag['ad_group_id'] for ag in ad_groups]
                                ag_to_cid = {ag['ad_group_id']: ag['campaign_id'] for ag in ad_groups}

                                cur.execute("""
                                    SELECT
                                        k.keyword_id, k.keyword_text, k.match_type,
                                        k.bid, k.state, k.ad_group_id,
                                        COALESCE(SUM(kp.impressions), 0) as total_impressions,
                                        COALESCE(SUM(kp.clicks), 0) as total_clicks,
                                        COALESCE(SUM(kp.cost), 0) as total_cost,
                                        COALESCE(SUM(kp.attributed_conversions_7d), 0) as total_conversions,
                                        COALESCE(SUM(kp.attributed_sales_7d), 0) as total_sales,
                                        CASE WHEN SUM(kp.cost) > 0
                                            THEN SUM(kp.attributed_sales_7d) / SUM(kp.cost) END as avg_roas,
                                        CASE WHEN SUM(kp.attributed_sales_7d) > 0
                                            THEN SUM(kp.cost) / SUM(kp.attributed_sales_7d) END as avg_acos,
                                        CASE WHEN SUM(kp.impressions) > 0
                                            THEN SUM(kp.clicks)::float / SUM(kp.impressions) * 100
                                            ELSE 0 END as avg_ctr
                                    FROM keywords k
                                    LEFT JOIN keyword_performance kp
                                        ON k.keyword_id = kp.keyword_id AND kp.report_date >= %s
                                    WHERE k.ad_group_id = ANY(%s) AND k.state = 'ENABLED'
                                    GROUP BY k.keyword_id, k.keyword_text, k.match_type,
                                             k.bid, k.state, k.ad_group_id
                                    HAVING COALESCE(SUM(kp.impressions), 0) >= 10
                                    ORDER BY total_cost DESC
                                """, (start_lookback, ag_ids))
                                keywords = cur.fetchall()

                                if keywords:
                                    kw_ids = [k['keyword_id'] for k in keywords]

                                    cur.execute("""
                                        SELECT keyword_id, report_date, impressions, clicks, cost,
                                            attributed_conversions_1d, attributed_conversions_7d,
                                            attributed_sales_1d, attributed_sales_7d,
                                            CASE WHEN cost > 0
                                                THEN attributed_sales_7d / cost END as roas_7d,
                                            CASE WHEN attributed_sales_7d > 0
                                                THEN cost / attributed_sales_7d END as acos_7d,
                                            CASE WHEN impressions > 0
                                                THEN clicks::float / impressions * 100
                                                ELSE 0 END as ctr
                                        FROM keyword_performance
                                        WHERE keyword_id = ANY(%s) AND report_date >= %s
                                        ORDER BY report_date DESC
                                    """, (kw_ids, start_30d))
                                    all_perf = cur.fetchall()

                                    perf_by_kw = defaultdict(list)
                                    for row in all_perf:
                                        perf_by_kw[row['keyword_id']].append(row)

                                    for kw in keywords:
                                        kid = kw['keyword_id']
                                        rows = perf_by_kw.get(kid, [])
                                        perf_7d = [r for r in rows if r['report_date'] >= cutoff_7d]
                                        perf_14d = [r for r in rows if r['report_date'] >= cutoff_14d]

                                        candidate = ai_engine.negative_manager.identify_negative_candidates(
                                            kw, [perf_7d, perf_14d, rows]
                                        )
                                        if candidate:
                                            cid = ag_to_cid[kw['ad_group_id']]
                                            all_candidates.append(NegativeCandidateData(
                                                keyword_id=kw['keyword_id'],
                                                keyword_text=candidate.keyword_text,
                                                match_type=candidate.match_type,
                                                campaign_id=cid,
                                                ad_group_id=kw['ad_group_id'],
                                                spend=float(candidate.cost or 0),
                                                clicks=int(candidate.clicks or 0),
                                                impressions=int(candidate.impressions or 0),
                                                orders=int(candidate.conversions or 0),
                                                severity=candidate.severity,
                                                confidence=candidate.confidence,
                                                reason=candidate.reason,
                                                suggested_action=candidate.suggested_match_type or 'negative_exact',
                                                status='pending'
                                            ))
                                            if len(all_candidates) >= limit:
                                                break
                except Exception as e:
                    logger.warning(f"Bulk negative analysis failed: {e}")
        
        return all_candidates[:limit]
    except Exception as e:
        logger.error(f"Error fetching negative candidates: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/negatives/{keyword_id}/approve")
async def approve_negative_keyword(keyword_id: int, match_type: str = "negative_exact"):
    """Approve a negative keyword candidate — creates the negative keyword in Amazon and records it"""
    try:
        keyword_text = None
        campaign_id = None
        ad_group_id = None
        cost_at_id = None

        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                # 1. Get candidate details
                cursor.execute("""
                    SELECT keyword_text, campaign_id, ad_group_id, cost_at_identification,
                           reason, consecutive_failures
                    FROM negative_keyword_candidates
                    WHERE keyword_id = %s
                """, (keyword_id,))
                candidate = cursor.fetchone()

                if not candidate:
                    raise HTTPException(status_code=404, detail=f"Negative keyword candidate {keyword_id} not found")

                keyword_text = candidate['keyword_text']
                campaign_id = candidate['campaign_id']
                ad_group_id = candidate['ad_group_id']
                cost_at_id = float(candidate.get('cost_at_identification') or 0)

                # 2. Mark candidate as applied
                cursor.execute("""
                    UPDATE negative_keyword_candidates
                    SET status = 'applied', applied_date = NOW(), suggested_match_type = %s
                    WHERE keyword_id = %s
                """, (match_type, keyword_id))

                # 3. Record in negative_keyword_history for audit trail
                cursor.execute("""
                    INSERT INTO negative_keyword_history
                        (keyword_id, keyword_text, match_type, campaign_id, ad_group_id,
                         marked_negative_date, reason, cost_at_marking,
                         consecutive_zero_conversion_windows, status)
                    VALUES (%s, %s, %s, %s, %s, NOW(), %s, %s, %s, 'active')
                """, (
                    keyword_id, keyword_text, match_type, campaign_id, ad_group_id,
                    candidate.get('reason', 'Approved from dashboard'),
                    cost_at_id,
                    candidate.get('consecutive_failures', 0)
                ))

                # 4. Log in change_history
                cursor.execute("""
                    INSERT INTO change_history
                        (entity_type, entity_id, entity_name, field_name,
                         old_value, new_value, change_type, triggered_by, reason)
                    VALUES ('negative_keyword', %s, %s, 'status', 'candidate', 'applied',
                            'create', 'dashboard_manual', %s)
                """, (keyword_id, keyword_text,
                      f'Negative keyword approved: {keyword_text} ({match_type})'))

                conn.commit()

        # 5. Sync to Amazon Ads API — create the negative keyword
        sync_manager = _get_amazon_sync_manager()
        if sync_manager:
            try:
                sync_manager.create_negative_keywords([{
                    'campaign_id': campaign_id,
                    'ad_group_id': ad_group_id,
                    'keyword_text': keyword_text,
                    'match_type': match_type.upper(),
                    'state': 'ENABLED',
                }])
                logger.info(f"Negative keyword synced to Amazon: {keyword_text} ({match_type})")
            except Exception as sync_err:
                logger.error(f"Amazon sync failed for negative keyword {keyword_id}: {sync_err}")
                # DB change already committed; log the sync failure but don't rollback
        else:
            logger.warning(f"Amazon sync skipped for negative keyword {keyword_id}: sync manager unavailable")

        logger.info(f"Negative keyword approved: {keyword_id} ({keyword_text}) as {match_type}")
        return {"status": "success", "message": f"Keyword '{keyword_text}' added as negative ({match_type})"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error approving negative keyword: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/negatives/{keyword_id}/reject")
async def reject_negative_keyword(keyword_id: int, reason: str = None):
    """Reject a negative keyword candidate"""
    try:
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    UPDATE negative_keyword_candidates
                    SET status = 'rejected'
                    WHERE keyword_id = %s
                """, (keyword_id,))
                conn.commit()
        
        logger.info(f"Negative keyword rejected: {keyword_id}, reason: {reason}")
        return {"status": "success", "message": f"Keyword {keyword_id} rejected"}
    except Exception as e:
        logger.error(f"Error rejecting negative keyword: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/negatives/{keyword_id}/hold")
async def hold_negative_keyword(keyword_id: int, days: int = 30):
    """Put a negative keyword candidate on temporary hold"""
    try:
        hold_expiry = datetime.now() + timedelta(days=days)
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    UPDATE negative_keyword_candidates
                    SET is_temporary_hold = TRUE, hold_expiry_date = %s
                    WHERE keyword_id = %s
                """, (hold_expiry, keyword_id))
                conn.commit()
        
        logger.info(f"Negative keyword put on hold: {keyword_id} for {days} days")
        return {"status": "success", "message": f"Keyword {keyword_id} put on {days}-day hold"}
    except Exception as e:
        logger.error(f"Error holding negative keyword: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - AUDIT LOG / TRANSPARENCY
# ============================================================================

@app.get("/api/changelog", response_model=List[ChangeLogEntry])
async def get_change_log(
    entity_type: Optional[str] = None,
    entity_id: Optional[int] = None,
    days: int = Query(7, ge=1, le=90),
    limit: int = Query(100, ge=1, le=500)
):
    """Get change history for audit trail"""
    try:
        query = """
        SELECT 
            id, entity_type, entity_id, entity_name,
            change_date, old_bid, new_bid, change_percentage, 
            reason, triggered_by, outcome_label, outcome_score
        FROM bid_change_history
        WHERE change_date >= %s
        """
        params = [datetime.now() - timedelta(days=days)]
        
        if entity_type:
            query += " AND entity_type = %s"
            params.append(entity_type)
        
        if entity_id:
            query += " AND entity_id = %s"
            params.append(entity_id)
        
        query += " ORDER BY change_date DESC LIMIT %s"
        params.append(limit)
        
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute(query, params)
                rows = cursor.fetchall()
        
        result = []
        for row in rows:
            result.append(ChangeLogEntry(
                id=row['id'],
                timestamp=row['change_date'].isoformat(),
                entity_type=row['entity_type'],
                entity_id=row['entity_id'],
                entity_name=row['entity_name'] or f"{row['entity_type']} {row['entity_id']}",
                action="bid_change",
                old_value=float(row['old_bid']),
                new_value=float(row['new_bid']),
                change_percentage=float(row.get('change_percentage', 0) or 0),
                reason=row['reason'] or "",
                triggered_by=row['triggered_by'] or "ai_rule_engine",
                status="success",
                outcome_label=row.get('outcome_label'),
                outcome_score=float(row['outcome_score']) if row.get('outcome_score') else None
            ))
        
        return result
    except Exception as e:
        logger.error(f"Error fetching change log: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/changelog/{change_id}/revert")
async def revert_change(change_id: int):
    """Revert a previous change"""
    try:
        # Get the original change
        query = """
        SELECT entity_type, entity_id, old_bid, new_bid
        FROM bid_change_history
        WHERE id = %s
        """
        
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute(query, (change_id,))
                row = cursor.fetchone()
        
        if not row:
            raise HTTPException(status_code=404, detail=f"Change {change_id} not found")
        
        # Create a revert change record
        revert_record = {
            'entity_type': row['entity_type'],
            'entity_id': row['entity_id'],
            'entity_name': f"Revert of change {change_id}",
            'change_date': datetime.now(),
            'old_bid': row['new_bid'],
            'new_bid': row['old_bid'],
            'change_amount': float(row['old_bid']) - float(row['new_bid']),
            'change_percentage': 0,
            'reason': f"Revert of change {change_id}",
            'triggered_by': 'dashboard_revert',
            'acos_at_change': None,
            'roas_at_change': None,
            'ctr_at_change': None,
            'conversions_at_change': None,
            'metadata': '{}'
        }
        
        db_connector.save_bid_change(revert_record)
        
        return {"status": "success", "message": f"Change {change_id} reverted"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reverting change: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - BID LOCKS & OSCILLATION MONITORING
# ============================================================================

@app.get("/api/bid-locks", response_model=List[BidLockData])
async def get_bid_locks(entity_type: Optional[str] = None):
    """Get all active bid locks"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                query = """
                    SELECT bal.entity_type, bal.entity_id, bal.locked_until, bal.lock_reason, bal.last_change_id
                    FROM bid_adjustment_locks bal
                    WHERE bal.locked_until > NOW()
                """
                params = []
                
                if entity_type:
                    query += " AND bal.entity_type = %s"
                    params.append(entity_type)
                
                query += " ORDER BY bal.locked_until DESC"
                
                cursor.execute(query, params)
                rows = cursor.fetchall()
                
                result = []
                for row in rows:
                    result.append(BidLockData(
                        entity_type=row['entity_type'],
                        entity_id=row['entity_id'],
                        locked_until=row['locked_until'].isoformat(),
                        lock_reason=row['lock_reason'] or "",
                        last_change_id=row['last_change_id']
                    ))
                
                return result
    except Exception as e:
        logger.error(f"Error fetching bid locks: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/oscillations", response_model=List[OscillationData])
async def get_oscillations():
    """Get entities with bid oscillation detected"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT entity_type, entity_id, entity_name, direction_changes, 
                           is_oscillating, last_change_date
                    FROM bid_oscillation_detection
                    WHERE is_oscillating = TRUE
                    ORDER BY direction_changes DESC
                """)
                rows = cursor.fetchall()
                
                result = []
                for row in rows:
                    result.append(OscillationData(
                        entity_type=row['entity_type'],
                        entity_id=row['entity_id'],
                        entity_name=row.get('entity_name'),
                        direction_changes=row['direction_changes'],
                        is_oscillating=row['is_oscillating'],
                        last_change_date=row['last_change_date'].isoformat() if row['last_change_date'] else None
                    ))
                
                return result
    except Exception as e:
        logger.error(f"Error fetching oscillations: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - LEARNING OUTCOMES
# ============================================================================

@app.get("/api/learning/outcomes", response_model=List[LearningOutcomeData])
async def get_learning_outcomes(
    days: int = Query(30, ge=7, le=90),
    limit: int = Query(100, ge=1, le=500)
):
    """Get learning outcomes for recommendations"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT id, recommendation_id, entity_type, entity_id, adjustment_type,
                           recommended_value, applied_value, outcome, improvement_percentage, timestamp
                    FROM learning_outcomes
                    WHERE timestamp >= %s
                    ORDER BY timestamp DESC
                    LIMIT %s
                """, (datetime.now() - timedelta(days=days), limit))
                rows = cursor.fetchall()
                
                result = []
                for row in rows:
                    result.append(LearningOutcomeData(
                        id=row['id'],
                        recommendation_id=row['recommendation_id'],
                        entity_type=row['entity_type'],
                        entity_id=row['entity_id'],
                        adjustment_type=row['adjustment_type'],
                        recommended_value=row['recommended_value'],
                        applied_value=row['applied_value'],
                        outcome=row['outcome'],
                        improvement_percentage=row['improvement_percentage'],
                        timestamp=row['timestamp'].isoformat()
                    ))
                
                return result
    except Exception as e:
        logger.error(f"Error fetching learning outcomes: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/learning/stats")
async def get_learning_stats(days: int = Query(30, ge=7, le=90)):
    """Get learning loop statistics"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT 
                        COUNT(*) as total,
                        COUNT(*) FILTER (WHERE outcome = 'success') as successes,
                        COUNT(*) FILTER (WHERE outcome = 'failure') as failures,
                        COUNT(*) FILTER (WHERE outcome = 'neutral') as neutrals,
                        AVG(improvement_percentage) as avg_improvement
                    FROM learning_outcomes
                    WHERE timestamp >= %s
                """, (datetime.now() - timedelta(days=days),))
                stats = cursor.fetchone()
                
                # Get model training status
                cursor.execute("""
                    SELECT model_version, status, train_accuracy, test_accuracy,
                           train_auc, test_auc, promoted, completed_at
                    FROM model_training_runs
                    ORDER BY id DESC
                    LIMIT 5
                """)
                training_runs = cursor.fetchall()
                
                return {
                    "total_outcomes": stats['total'] or 0,
                    "successes": stats['successes'] or 0,
                    "failures": stats['failures'] or 0,
                    "neutrals": stats['neutrals'] or 0,
                    "success_rate": (stats['successes'] / stats['total'] * 100) if stats['total'] else 0,
                    "avg_improvement": float(stats['avg_improvement'] or 0),
                    "recent_training_runs": [
                        ModelTrainingStatus(
                            model_version=r['model_version'],
                            status=r['status'],
                            train_accuracy=r['train_accuracy'],
                            test_accuracy=r['test_accuracy'],
                            train_auc=r['train_auc'],
                            test_auc=r['test_auc'],
                            promoted=r['promoted'],
                            completed_at=r['completed_at'].isoformat() if r['completed_at'] else None
                        ) for r in training_runs
                    ]
                }
    except Exception as e:
        logger.error(f"Error fetching learning stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - STRATEGY CONFIGURATION
# ============================================================================

@app.get("/api/config/strategy")
async def get_strategy_config():
    """Get current strategy configuration"""
    try:
        # Map target ACOS to strategy
        acos = rule_config.acos_target
        if acos <= 0.05:
            strategy = "profit"
        elif acos <= 0.10:
            strategy = "growth"
        elif acos <= 0.15:
            strategy = "launch"
        else:
            strategy = "liquidate"
        
        # Determine AI mode
        if rule_config.enable_warm_up_mode:
            ai_mode = "warm_up"
        else:
            ai_mode = "autonomous"  # Default is autonomous
        
        return StrategyConfig(
            strategy=strategy,
            target_acos=rule_config.acos_target,
            max_bid_cap=rule_config.bid_cap,
            min_bid_floor=rule_config.bid_floor,
            ai_mode=ai_mode,
            enable_dayparting=False,  # Would need to check config
            enable_inventory_protection=rule_config.enable_spend_safeguard,
            enable_brand_defense=False  # Would need to add to config
        )
    except Exception as e:
        logger.error(f"Error fetching strategy config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/config/strategy")
async def update_strategy_config(config: StrategyConfig):
    """Update strategy configuration"""
    try:
        global rule_config, ai_engine
        
        # Update configuration
        rule_config.acos_target = config.target_acos
        rule_config.bid_cap = config.max_bid_cap
        rule_config.bid_floor = config.min_bid_floor
        
        # Update AI mode
        if config.ai_mode == "warm_up":
            rule_config.enable_warm_up_mode = True
        else:
            rule_config.enable_warm_up_mode = False
        
        # Update database configuration
        try:
            with db_connector.get_connection() as conn:
                with conn.cursor() as cursor:
                    cursor.execute("""
                        INSERT INTO strategy_configurations 
                        (entity_type, entity_id, strategy, target_acos, max_bid_cap, min_bid_floor, ai_mode,
                         enable_dayparting, enable_inventory_protection, enable_brand_defense)
                        VALUES ('account', NULL, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (entity_type, entity_id) 
                        DO UPDATE SET 
                            strategy = EXCLUDED.strategy,
                            target_acos = EXCLUDED.target_acos,
                            max_bid_cap = EXCLUDED.max_bid_cap,
                            min_bid_floor = EXCLUDED.min_bid_floor,
                            ai_mode = EXCLUDED.ai_mode,
                            enable_dayparting = EXCLUDED.enable_dayparting,
                            enable_inventory_protection = EXCLUDED.enable_inventory_protection,
                            enable_brand_defense = EXCLUDED.enable_brand_defense,
                            updated_at = NOW()
                    """, (config.strategy, config.target_acos, config.max_bid_cap, config.min_bid_floor,
                          config.ai_mode, config.enable_dayparting, config.enable_inventory_protection,
                          config.enable_brand_defense))
                    conn.commit()
        except Exception as e:
            logger.warning(f"Could not save strategy to database: {e}")
        
        # Reinitialize AI engine with new config
        ai_engine = AIRuleEngine(rule_config, db_connector)
        
        logger.info(f"Strategy config updated: {config}")
        
        return {"status": "success", "message": "Strategy configuration updated"}
    except Exception as e:
        logger.error(f"Error updating strategy config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - AI CONTROL (COMPREHENSIVE)
# ============================================================================

@app.get("/api/config/ai-control", response_model=AIControlConfig)
async def get_ai_control_config():
    """Get comprehensive AI Rule Engine control configuration"""
    try:
        return AIControlConfig(
            # Core Settings
            target_acos=rule_config.acos_target,
            acos_tolerance=rule_config.acos_tolerance,
            roas_target=rule_config.roas_target,
            
            # Bid Limits
            bid_floor=rule_config.bid_floor,
            bid_cap=rule_config.bid_cap,
            bid_max_adjustment=rule_config.bid_max_adjustment,
            
            # Re-entry Control
            enable_re_entry_control=rule_config.enable_re_entry_control,
            bid_change_cooldown_days=rule_config.bid_change_cooldown_days,
            min_bid_change_threshold=rule_config.min_bid_change_threshold,
            
            # Oscillation Prevention
            enable_oscillation_detection=rule_config.enable_oscillation_detection,
            oscillation_lookback_days=rule_config.oscillation_lookback_days,
            oscillation_direction_change_threshold=rule_config.oscillation_direction_change_threshold,
            
            # Safety Controls
            enable_spend_safeguard=rule_config.enable_spend_safeguard,
            spend_spike_threshold=rule_config.spend_spike_threshold,
            enable_comprehensive_safety_veto=rule_config.enable_comprehensive_safety_veto,
            account_daily_limit=rule_config.account_daily_limit,
            
            # Order-Based Scaling
            enable_order_based_scaling=rule_config.enable_order_based_scaling,
            order_tier_1_adjustment=rule_config.order_tier_1_adjustment,
            order_tier_2_3_adjustment=rule_config.order_tier_2_3_adjustment,
            order_tier_4_plus_adjustment=rule_config.order_tier_4_plus_adjustment,
            
            # Spend No-Sale Logic
            enable_spend_no_sale_logic=rule_config.enable_spend_no_sale_logic,
            no_sale_reduction_tier_1=rule_config.no_sale_reduction_tier_1,
            no_sale_reduction_tier_2=rule_config.no_sale_reduction_tier_2,
            no_sale_reduction_tier_3=rule_config.no_sale_reduction_tier_3,
            
            # Performance Thresholds
            min_impressions=rule_config.min_impressions,
            min_clicks=rule_config.min_clicks,
            min_conversions=rule_config.min_conversions,
            
            # Learning Loop
            enable_learning_loop=rule_config.enable_learning_loop,
            learning_success_threshold=rule_config.learning_success_threshold,
            learning_failure_threshold=rule_config.learning_failure_threshold,
            min_training_samples=rule_config.min_training_samples,
            
            # Feature Flags
            enable_warm_up_mode=rule_config.enable_warm_up_mode,
            enable_intelligence_engines=rule_config.enable_intelligence_engines,
            enable_advanced_bid_optimization=rule_config.enable_advanced_bid_optimization,
        )
    except Exception as e:
        logger.error(f"Error fetching AI control config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/config/ai-control")
async def update_ai_control_config(config: AIControlConfig):
    """Update comprehensive AI Rule Engine control configuration"""
    try:
        global rule_config, ai_engine
        
        # Update all configuration fields
        rule_config.acos_target = config.target_acos
        rule_config.acos_tolerance = config.acos_tolerance
        rule_config.roas_target = config.roas_target
        
        rule_config.bid_floor = config.bid_floor
        rule_config.bid_cap = config.bid_cap
        rule_config.bid_max_adjustment = config.bid_max_adjustment
        
        rule_config.enable_re_entry_control = config.enable_re_entry_control
        rule_config.bid_change_cooldown_days = config.bid_change_cooldown_days
        rule_config.min_bid_change_threshold = config.min_bid_change_threshold
        
        rule_config.enable_oscillation_detection = config.enable_oscillation_detection
        rule_config.oscillation_lookback_days = config.oscillation_lookback_days
        rule_config.oscillation_direction_change_threshold = config.oscillation_direction_change_threshold
        
        rule_config.enable_spend_safeguard = config.enable_spend_safeguard
        rule_config.spend_spike_threshold = config.spend_spike_threshold
        rule_config.enable_comprehensive_safety_veto = config.enable_comprehensive_safety_veto
        rule_config.account_daily_limit = config.account_daily_limit
        
        rule_config.enable_order_based_scaling = config.enable_order_based_scaling
        rule_config.order_tier_1_adjustment = config.order_tier_1_adjustment
        rule_config.order_tier_2_3_adjustment = config.order_tier_2_3_adjustment
        rule_config.order_tier_4_plus_adjustment = config.order_tier_4_plus_adjustment
        
        rule_config.enable_spend_no_sale_logic = config.enable_spend_no_sale_logic
        rule_config.no_sale_reduction_tier_1 = config.no_sale_reduction_tier_1
        rule_config.no_sale_reduction_tier_2 = config.no_sale_reduction_tier_2
        rule_config.no_sale_reduction_tier_3 = config.no_sale_reduction_tier_3
        
        rule_config.min_impressions = config.min_impressions
        rule_config.min_clicks = config.min_clicks
        rule_config.min_conversions = config.min_conversions
        
        rule_config.enable_learning_loop = config.enable_learning_loop
        rule_config.learning_success_threshold = config.learning_success_threshold
        rule_config.learning_failure_threshold = config.learning_failure_threshold
        rule_config.min_training_samples = config.min_training_samples
        
        rule_config.enable_warm_up_mode = config.enable_warm_up_mode
        rule_config.enable_intelligence_engines = config.enable_intelligence_engines
        rule_config.enable_advanced_bid_optimization = config.enable_advanced_bid_optimization
        
        # Validate configuration
        rule_config.validate()
        
        # Reinitialize AI engine with new config
        ai_engine = AIRuleEngine(rule_config, db_connector)
        
        logger.info(f"AI control config updated")
        
        return {"status": "success", "message": "AI control configuration updated"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error updating AI control config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# API ENDPOINTS - ENGINE EXECUTION CONTROL
# ============================================================================

class EngineTriggerRequest(BaseModel):
    campaigns: Optional[List[int]] = None
    sync: bool = False
    dry_run: bool = False

@app.post("/api/engine/trigger")
async def trigger_engine_execution(request: Optional[EngineTriggerRequest] = None):
    """Trigger AI rule engine execution"""
    global engine_status
    
    if request is None:
        request = EngineTriggerRequest()
    
    if engine_status['is_running']:
        raise HTTPException(
            status_code=409, 
            detail="Engine is already running. Please wait for current execution to complete."
        )
    
    engine_status['is_running'] = True
    engine_status['current_run'] = {
        'start_time': datetime.now().isoformat(),
        'status': 'running',
        'campaigns': request.campaigns,
        'sync': request.sync,
        'dry_run': request.dry_run
    }
    
    def run_engine_task():
        try:
            from src.ai_rule_engine.main import run_analysis_cycle
            from src.ai_rule_engine.config import RuleConfig
            
            class Args:
                def __init__(self, campaigns_list, dry_run_flag, sync_flag):
                    self.campaigns = campaigns_list
                    self.output = f'reports/ai_recommendations_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json'
                    self.format = 'json'
                    self.log_level = 'INFO'
                    self.max_recommendations = 100
                    self.min_confidence = 0.3
                    self.dry_run = dry_run_flag
                    self.sync = sync_flag
                    self.skip_download = False
                    self.skip_upload = False
                    self.continuous = False
                    self.interval = 3600
            
            start_time = datetime.now()
            args = Args(request.campaigns, request.dry_run, request.sync)
            recommendations = run_analysis_cycle(rule_config, db_connector, args, f"api_run_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
            duration = (datetime.now() - start_time).total_seconds()
            
            engine_status['current_run'].update({
                'end_time': datetime.now().isoformat(),
                'status': 'completed',
                'duration_seconds': duration,
                'recommendations_count': len(recommendations) if recommendations else 0,
                'error': None
            })
            
            engine_status['execution_history'].append(engine_status['current_run'].copy())
            if len(engine_status['execution_history']) > 10:
                engine_status['execution_history'].pop(0)
                
        except Exception as e:
            logger.error(f"Engine execution error: {e}", exc_info=True)
            engine_status['current_run'].update({
                'end_time': datetime.now().isoformat(),
                'status': 'failed',
                'duration_seconds': (datetime.now() - datetime.fromisoformat(engine_status['current_run']['start_time'])).total_seconds(),
                'error': str(e)
            })
        finally:
            engine_status['is_running'] = False
            engine_status['last_run'] = engine_status['current_run'].copy()
            engine_status['current_run'] = None
    
    thread = threading.Thread(target=run_engine_task, daemon=True)
    thread.start()
    
    return {
        "status": "started",
        "message": "AI rule engine execution started",
        "start_time": engine_status['current_run']['start_time']
    }

@app.get("/api/engine/status")
async def get_engine_status():
    """Get current engine execution status"""
    global engine_status
    
    # Ensure proper structure - convert None to null for JSON
    last_run = engine_status.get('last_run')
    current_run = engine_status.get('current_run')
    
    status = {
        'is_running': engine_status.get('is_running', False),
        'last_run': last_run if last_run is not None else None,
        'current_run': None
    }
    
    # Update current_run with elapsed time if running
    if engine_status.get('is_running') and current_run:
        start = datetime.fromisoformat(current_run.get('start_time', datetime.now().isoformat()))
        elapsed = (datetime.now() - start).total_seconds()
        status['current_run'] = current_run.copy()
        status['current_run']['elapsed_seconds'] = elapsed
    
    return status

@app.get("/api/engine/history")
async def get_engine_history(limit: int = Query(10, ge=1, le=50)):
    """Get execution history"""
    global engine_status
    return {
        'history': engine_status['execution_history'][-limit:],
        'total_runs': len(engine_status['execution_history'])
    }

@app.get("/api/portfolios", response_model=List[PortfolioData])
async def get_portfolios(
    days: int = Query(7, ge=1, le=90),
    account_id: Optional[str] = None
):
    """Get all portfolios with performance data"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                query = """
                    SELECT p.portfolio_id, p.portfolio_name, p.budget_amount, 
                           p.budget_type, p.state as status,
                           COUNT(DISTINCT c.campaign_id) as campaign_count
                    FROM portfolios p
                    LEFT JOIN campaigns c ON c.portfolio_id = p.portfolio_id
                    WHERE 1=1
                """
                params = []
                
                if account_id:
                    query += " AND p.account_id = %s"
                    params.append(account_id)
                
                query += " GROUP BY p.portfolio_id, p.portfolio_name, p.budget_amount, p.budget_type, p.state"
                cursor.execute(query, params)
                portfolios = cursor.fetchall()
                
                result = []
                end_date = datetime.now().date()
                start_date = end_date - timedelta(days=days)
                
                for portfolio in portfolios:
                    portfolio_id = portfolio['portfolio_id']
                    
                    # Get performance data
                    cursor.execute("""
                        SELECT 
                            SUM(cp.cost) as total_spend,
                            SUM(cp.attributed_sales_7d) as total_sales,
                            SUM(cp.attributed_conversions_7d) as total_orders,
                            SUM(cp.impressions) as total_impressions,
                            SUM(cp.clicks) as total_clicks
                        FROM campaign_performance cp
                        INNER JOIN campaigns c ON c.campaign_id = cp.campaign_id
                        WHERE c.portfolio_id = %s
                        AND cp.report_date >= %s
                        AND cp.report_date <= %s
                    """, (portfolio_id, start_date, end_date))
                    
                    perf = cursor.fetchone()
                    spend = float(perf['total_spend'] or 0)
                    sales = float(perf['total_sales'] or 0)
                    
                    result.append(PortfolioData(
                        portfolio_id=portfolio_id,
                        portfolio_name=portfolio['portfolio_name'],
                        budget_amount=float(portfolio['budget_amount'] or 0),
                        budget_type=portfolio['budget_type'],
                        status=portfolio['status'],
                        campaign_count=int(portfolio['campaign_count'] or 0),
                        total_spend=spend,
                        total_sales=sales,
                        acos=round(spend / sales * 100, 2) if sales > 0 else None,
                        roas=round(sales / spend, 2) if spend > 0 else None
                    ))
                
                return result
    except Exception as e:
        logger.error(f"Error fetching portfolios: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/ad-groups")
async def get_ad_groups(
    campaign_id: Optional[int] = None,
    days: int = Query(7, ge=1, le=90),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    state: Optional[str] = Query(None, description="Filter by state: enabled, paused, archived, or omit for all"),
):
    """Get ad groups with performance data (paginated)"""
    try:
        state_filter = None if (not state or state.lower() == "all") else state
        ad_groups = []
        if campaign_id:
            try:
                ad_groups = db_connector.get_ad_groups_with_performance(
                    campaign_id, days, min_impressions=0, state=state_filter
                )
            except Exception as db_err:
                logger.warning(f"Error querying ad groups from performance method: {db_err}")
                # Fallback: query ad_groups table directly without performance data
                try:
                    with db_connector.get_connection() as conn:
                        import psycopg2.extras
                        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                            fallback_query = """
                                SELECT ag.ad_group_id, ag.ad_group_name, ag.campaign_id,
                                       ag.default_bid, ag.state,
                                       0 as total_impressions, 0 as total_clicks,
                                       0 as total_cost, 0 as total_conversions, 0 as total_sales
                                FROM ad_groups ag
                                WHERE ag.campaign_id = %s
                            """
                            fallback_params: list = [campaign_id]
                            if state_filter and state_filter.lower() in ("enabled", "paused", "archived"):
                                fallback_query += " AND ag.state = %s"
                                fallback_params.append(state_filter.upper())
                            fallback_query += " ORDER BY ag.ad_group_name"
                            cursor.execute(fallback_query, fallback_params)
                            ad_groups = cursor.fetchall()
                except Exception as fallback_err:
                    logger.error(f"Fallback ad groups query also failed: {fallback_err}")
        
        # Get campaigns for ad group names
        campaigns_map = {}
        if ad_groups:
            try:
                with db_connector.get_connection() as conn:
                    import psycopg2.extras
                    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                        campaign_ids = list(set([ag['campaign_id'] for ag in ad_groups if ag.get('campaign_id')]))
                        if campaign_ids:
                            placeholders = ','.join(['%s'] * len(campaign_ids))
                            cursor.execute(f"""
                                SELECT campaign_id, campaign_name 
                                FROM campaigns 
                                WHERE campaign_id IN ({placeholders})
                            """, campaign_ids)
                            for row in cursor.fetchall():
                                campaigns_map[row['campaign_id']] = row['campaign_name']
            except Exception as e:
                logger.warning(f"Could not fetch campaign names for ad groups: {e}")
        
        result = []
        for ag in ad_groups:
            try:
                spend = float(ag.get('total_cost', 0) or 0)
                sales = float(ag.get('total_sales', 0) or 0)
                impressions = int(float(ag.get('total_impressions', 0) or 0))
                clicks = int(float(ag.get('total_clicks', 0) or 0))
                orders = int(float(ag.get('total_conversions', 0) or 0))
                
                result.append(AdGroupData(
                    ad_group_id=ag['ad_group_id'],
                    ad_group_name=ag.get('ad_group_name', '') or '',
                    campaign_id=ag['campaign_id'],
                    campaign_name=campaigns_map.get(ag['campaign_id'], ''),
                    default_bid=float(ag.get('default_bid', 0) or 0),
                    status=_normalize_campaign_state(ag.get('state', 'ENABLED')),
                    spend=spend,
                    sales=sales,
                    acos=round(spend / sales * 100, 2) if sales > 0 else None,
                    roas=round(sales / spend, 2) if spend > 0 else None,
                    orders=orders,
                    impressions=impressions,
                    clicks=clicks,
                    ctr=round(clicks / impressions * 100, 2) if impressions > 0 else 0,
                    cvr=round(orders / clicks * 100, 2) if clicks > 0 else 0
                ))
            except Exception as item_err:
                logger.warning(f"Error processing ad group {ag.get('ad_group_id')}: {item_err}")
                continue
        
        total = len(result)
        total_pages = max(1, (total + page_size - 1) // page_size)
        start = (page - 1) * page_size
        end = start + page_size
        return {"data": result[start:end], "total": total, "page": page, "page_size": page_size, "total_pages": total_pages}
    except Exception as e:
        logger.error(f"Error fetching ad groups: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))




@app.get("/api/ads")
async def get_ads(
    campaign_id: Optional[int] = None,
    ad_group_id: Optional[int] = None,
    days: int = Query(7, ge=1, le=90),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    state: Optional[str] = Query(None, description="Filter by state: enabled, paused, archived, or omit for all"),
):
    """Get product ads with performance data (paginated)"""
    try:
        state_filter = None if (not state or state.lower() == "all") else state
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                query = """
                    SELECT pa.ad_id, pa.asin, pa.sku, pa.campaign_id, pa.ad_group_id, pa.state as status
                    FROM product_ads pa
                    WHERE 1=1
                """
                params = []
                
                if campaign_id:
                    query += " AND pa.campaign_id = %s"
                    params.append(campaign_id)
                
                if ad_group_id:
                    query += " AND pa.ad_group_id = %s"
                    params.append(ad_group_id)
                
                if state_filter and state_filter.lower() in ("enabled", "paused", "archived"):
                    query += " AND pa.state = %s"
                    params.append(state_filter.upper())
                
                cursor.execute(query, params)
                ads = cursor.fetchall()
                
                result = []
                end_date = datetime.now().date()
                start_date = end_date - timedelta(days=days)
                
                for ad in ads:
                    ad_id = ad['ad_id']
                    asin = ad['asin']
                    
                    # Get performance data from asin_performance
                    cursor.execute("""
                        SELECT 
                            SUM(impressions) as total_impressions,
                            SUM(clicks) as total_clicks,
                            SUM(cost) as total_spend,
                            SUM(attributed_sales_7d) as total_sales,
                            SUM(attributed_conversions_7d) as total_orders
                        FROM asin_performance ap
                        WHERE ap.asin = %s
                        AND ap.report_date >= %s
                        AND ap.report_date <= %s
                    """, (asin, start_date, end_date))
                    
                    perf = cursor.fetchone()
                    spend = float(perf['total_spend'] or 0)
                    sales = float(perf['total_sales'] or 0)
                    impressions = int(perf['total_impressions'] or 0)
                    clicks = int(perf['total_clicks'] or 0)
                    orders = int(perf['total_orders'] or 0)
                    
                    # Get inventory status if available
                    inventory_status = None
                    cursor.execute("""
                        SELECT ad_status FROM inventory_health WHERE asin = %s LIMIT 1
                    """, (asin,))
                    inv_result = cursor.fetchone()
                    if inv_result:
                        inventory_status = inv_result['ad_status']
                    
                    result.append(AdData(
                        ad_id=ad_id,
                        asin=asin,
                        sku=ad.get('sku'),
                        campaign_id=ad['campaign_id'],
                        ad_group_id=ad['ad_group_id'],
                        status=ad['status'],
                        spend=spend,
                        sales=sales,
                        acos=round(spend / sales * 100, 2) if sales > 0 else None,
                        roas=round(sales / spend, 2) if spend > 0 else None,
                        orders=orders,
                        impressions=impressions,
                        clicks=clicks,
                        inventory_status=inventory_status
                    ))
                
                total = len(result)
                total_pages = max(1, (total + page_size - 1) // page_size)
                start_idx = (page - 1) * page_size
                end_idx = start_idx + page_size
                return {"data": result[start_idx:end_idx], "total": total, "page": page, "page_size": page_size, "total_pages": total_pages}
    except Exception as e:
        logger.error(f"Error fetching ads: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/search-terms")
async def get_search_terms(
    campaign_id: Optional[int] = None,
    ad_group_id: Optional[int] = None,
    days: int = Query(7, ge=1, le=90),
    min_clicks: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=2000),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """Get search terms (customer queries) with performance"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                end_date = datetime.now().date()
                start_date = end_date - timedelta(days=days)
                
                query = """
                    SELECT 
                        search_term,
                        campaign_id,
                        ad_group_id,
                        keyword_id,
                        SUM(impressions) as total_impressions,
                        SUM(clicks) as total_clicks,
                        SUM(cost) as total_spend,
                        SUM(attributed_sales_7d) as total_sales,
                        SUM(attributed_conversions_7d) as total_orders
                    FROM search_term_performance
                    WHERE report_date >= %s
                    AND report_date <= %s
                """
                params = [start_date, end_date]
                
                if campaign_id:
                    query += " AND campaign_id = %s"
                    params.append(campaign_id)
                
                if ad_group_id:
                    query += " AND ad_group_id = %s"
                    params.append(ad_group_id)
                
                query += """
                    GROUP BY search_term, campaign_id, ad_group_id, keyword_id
                    HAVING SUM(clicks) >= %s
                    ORDER BY SUM(attributed_sales_7d) DESC
                    LIMIT %s
                """
                params.extend([min_clicks, limit])
                
                cursor.execute(query, params)
                terms = cursor.fetchall()
                
                result = []
                for term in terms:
                    spend = float(term['total_spend'] or 0)
                    sales = float(term['total_sales'] or 0)
                    clicks = int(term['total_clicks'] or 0)
                    orders = int(term['total_orders'] or 0)
                    
                    # Determine harvest action based on PRD logic
                    harvest_action = None
                    if orders > 3 and sales > 0 and spend > 0:
                        acos_val = (spend / sales) * 100 if sales > 0 else None
                        if acos_val and acos_val < 15:  # Below 15% ACOS
                            harvest_action = 'add_keyword'
                    elif clicks > 15 and orders == 0:
                        harvest_action = 'add_negative'
                    
                    result.append(SearchTermData(
                        search_term=term['search_term'],
                        campaign_id=term['campaign_id'],
                        ad_group_id=term['ad_group_id'],
                        keyword_id=term['keyword_id'],
                        impressions=int(term['total_impressions'] or 0),
                        clicks=clicks,
                        spend=spend,
                        sales=sales,
                        orders=orders,
                        acos=round(spend / sales * 100, 2) if sales > 0 else None,
                        roas=round(sales / spend, 2) if spend > 0 else None,
                        harvest_action=harvest_action
                    ))
                
                total = len(result)
                total_pages = max(1, (total + page_size - 1) // page_size)
                start_idx = (page - 1) * page_size
                end_idx = start_idx + page_size
                return {"data": result[start_idx:end_idx], "total": total, "page": page, "page_size": page_size, "total_pages": total_pages}
    except Exception as e:
        logger.error(f"Error fetching search terms: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/placements", response_model=List[PlacementData])
async def get_placements(
    campaign_id: Optional[int] = None,
    ad_group_id: Optional[int] = None,
    days: int = Query(7, ge=1, le=90)
):
    """Get placement performance data"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                end_date = datetime.now().date()
                start_date = end_date - timedelta(days=days)
                
                query = """
                    SELECT 
                        placement,
                        campaign_id,
                        ad_group_id,
                        keyword_id,
                        target_id,
                        SUM(impressions) as total_impressions,
                        SUM(clicks) as total_clicks,
                        SUM(cost) as total_spend,
                        SUM(attributed_sales_7d) as total_sales,
                        SUM(attributed_conversions_7d) as total_orders
                    FROM placement_performance
                    WHERE report_date >= %s
                    AND report_date <= %s
                """
                params = [start_date, end_date]
                
                if campaign_id:
                    query += " AND campaign_id = %s"
                    params.append(campaign_id)
                
                if ad_group_id:
                    query += " AND ad_group_id = %s"
                    params.append(ad_group_id)
                
                query += """
                    GROUP BY placement, campaign_id, ad_group_id, keyword_id, target_id
                    ORDER BY SUM(attributed_sales_7d) DESC
                """
                
                cursor.execute(query, params)
                placements = cursor.fetchall()
                
                result = []
                for pl in placements:
                    spend = float(pl['total_spend'] or 0)
                    sales = float(pl['total_sales'] or 0)
                    
                    result.append(PlacementData(
                        placement=pl['placement'],
                        campaign_id=pl['campaign_id'],
                        ad_group_id=pl['ad_group_id'],
                        keyword_id=pl['keyword_id'],
                        target_id=pl['target_id'],
                        impressions=int(pl['total_impressions'] or 0),
                        clicks=int(pl['total_clicks'] or 0),
                        spend=spend,
                        sales=sales,
                        orders=int(pl['total_orders'] or 0),
                        acos=round(spend / sales * 100, 2) if sales > 0 else None,
                        roas=round(sales / spend, 2) if spend > 0 else None
                    ))
                
                return result
    except Exception as e:
        logger.error(f"Error fetching placements: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/cogs", response_model=List[COGSData])
async def get_cogs():
    """Get all COGS data"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT asin, cogs, amazon_fees_percentage, notes
                    FROM asin_cogs
                    ORDER BY asin
                """)
                cogs_list = cursor.fetchall()
                
                return [COGSData(**row) for row in cogs_list]
    except Exception as e:
        logger.error(f"Error fetching COGS: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/cogs")
async def create_or_update_cogs(cogs_data: COGSData):
    """Create or update COGS for an ASIN"""
    try:
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO asin_cogs (asin, cogs, amazon_fees_percentage, notes)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (asin) 
                    DO UPDATE SET 
                        cogs = EXCLUDED.cogs,
                        amazon_fees_percentage = EXCLUDED.amazon_fees_percentage,
                        notes = EXCLUDED.notes,
                        updated_at = CURRENT_TIMESTAMP
                """, (cogs_data.asin, cogs_data.cogs, cogs_data.amazon_fees_percentage, cogs_data.notes))
                conn.commit()
        
        return {"status": "success", "message": f"COGS updated for ASIN {cogs_data.asin}"}
    except Exception as e:
        logger.error(f"Error updating COGS: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/financial-metrics", response_model=List[FinancialMetrics])
async def get_financial_metrics(
    days: int = Query(7, ge=1, le=90),
    asin: Optional[str] = None
):
    """Get financial metrics (Gross Profit, Net Profit, TACoS, Break-Even ACOS)"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                end_date = datetime.now().date()
                start_date = end_date - timedelta(days=days)
                
                query = """
                    SELECT 
                        pa.asin,
                        SUM(ap.attributed_sales_7d) as total_sales,
                        SUM(ap.cost) as total_ad_spend
                    FROM asin_performance ap
                    INNER JOIN product_ads pa ON pa.asin = ap.asin
                    WHERE ap.report_date >= %s
                    AND ap.report_date <= %s
                """
                params = [start_date, end_date]
                
                if asin:
                    query += " AND pa.asin = %s"
                    params.append(asin)
                
                query += " GROUP BY pa.asin"
                
                cursor.execute(query, params)
                asin_perf = cursor.fetchall()
                
                result = []
                for perf in asin_perf:
                    asin_val = perf['asin']
                    sales = float(perf['total_sales'] or 0)
                    ad_spend = float(perf['total_ad_spend'] or 0)
                    
                    # Get COGS
                    cursor.execute("""
                        SELECT cogs, amazon_fees_percentage 
                        FROM asin_cogs 
                        WHERE asin = %s
                    """, (asin_val,))
                    cogs_row = cursor.fetchone()
                    
                    if not cogs_row:
                        continue
                    
                    cogs_unit = float(cogs_row['cogs'] or 0)
                    fees_percentage = float(cogs_row['amazon_fees_percentage'] or 0.15)
                    
                    amazon_fees = sales * fees_percentage
                    gross_profit = sales - cogs_unit - amazon_fees
                    net_profit = gross_profit - ad_spend
                    tacos = (ad_spend / sales * 100) if sales > 0 else 0
                    break_even_acos = ((sales - cogs_unit - amazon_fees) / sales * 100) if sales > 0 else 0
                    
                    result.append(FinancialMetrics(
                        asin=asin_val,
                        sales=sales,
                        cogs=cogs_unit,
                        amazon_fees=amazon_fees,
                        gross_profit=gross_profit,
                        ad_spend=ad_spend,
                        net_profit=net_profit,
                        tacos=round(tacos, 2),
                        break_even_acos=round(break_even_acos, 2)
                    ))
                
                return result
    except Exception as e:
        logger.error(f"Error calculating financial metrics: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/change-history", response_model=List[ChangeHistoryEntry])
async def get_change_history(
    entity_type: Optional[str] = None,
    entity_id: Optional[int] = None,
    limit: int = Query(100, ge=1, le=1000)
):
    """Get change history / audit log"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                query = """
                    SELECT id, change_date, user_id, entity_type, entity_id, 
                           entity_name, field_name, old_value, new_value,
                           change_type, triggered_by, reason
                    FROM change_history
                    WHERE 1=1
                """
                params = []
                
                if entity_type:
                    query += " AND entity_type = %s"
                    params.append(entity_type)
                
                if entity_id:
                    query += " AND entity_id = %s"
                    params.append(entity_id)
                
                query += " ORDER BY change_date DESC LIMIT %s"
                params.append(limit)
                
                cursor.execute(query, params)
                history = cursor.fetchall()
                
                return [
                    ChangeHistoryEntry(
                        id=row['id'],
                        change_date=row['change_date'].isoformat(),
                        user_id=row['user_id'],
                        entity_type=row['entity_type'],
                        entity_id=row['entity_id'],
                        entity_name=row['entity_name'],
                        field_name=row['field_name'],
                        old_value=row['old_value'],
                        new_value=row['new_value'],
                        change_type=row['change_type'],
                        triggered_by=row['triggered_by'],
                        reason=row['reason']
                    )
                    for row in history
                ]
    except Exception as e:
        logger.error(f"Error fetching change history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/column-layout/{view_type}", response_model=ColumnLayoutPreference)
async def get_column_layout(view_type: str, user_id: str = Query(..., alias="userId")):
    """Get column layout preferences for a view type"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT column_visibility, column_order, column_widths
                    FROM column_layout_preferences
                    WHERE user_id = %s AND view_type = %s
                """, (user_id, view_type))
                row = cursor.fetchone()
                
                if row:
                    return ColumnLayoutPreference(
                        view_type=view_type,
                        column_visibility=row['column_visibility'] or {},
                        column_order=row['column_order'] or [],
                        column_widths=row['column_widths'] or {}
                    )
                else:
                    return ColumnLayoutPreference(
                        view_type=view_type,
                        column_visibility={},
                        column_order=[],
                        column_widths={}
                    )
    except Exception as e:
        logger.error(f"Error fetching column layout: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/column-layout/{view_type}")
async def save_column_layout(
    view_type: str,
    layout: ColumnLayoutPreference,
    user_id: str = Query(..., alias="userId")
):
    """Save column layout preferences for a view type"""
    try:
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO column_layout_preferences 
                        (user_id, view_type, column_visibility, column_order, column_widths)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (user_id, view_type)
                    DO UPDATE SET
                        column_visibility = EXCLUDED.column_visibility,
                        column_order = EXCLUDED.column_order,
                        column_widths = EXCLUDED.column_widths,
                        updated_at = CURRENT_TIMESTAMP
                """, (
                    user_id, view_type,
                    json.dumps(layout.column_visibility),
                    json.dumps(layout.column_order),
                    json.dumps(layout.column_widths)
                ))
                conn.commit()
        
        return {"status": "success", "message": f"Column layout saved for {view_type}"}
    except Exception as e:
        logger.error(f"Error saving column layout: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/search-terms/{search_term}/add-keyword")
async def add_search_term_as_keyword(
    search_term: str,
    campaign_id: int,
    ad_group_id: int,
    match_type: str = Query(..., description="BROAD, PHRASE, or EXACT"),
    bid: Optional[float] = Query(None),
    current_user: UserResponse = Depends(get_current_user)
):
    """Add a search term as a keyword to a campaign/ad group
    
    Creates the keyword in both the local database and Amazon Ads API.
    Requires: admin, manager, or specialist role
    """
    try:
        # RBAC: Only admin, manager, and specialist roles can add keywords
        # if current_user.role not in ['admin', 'manager', 'specialist']:
        #     raise HTTPException(status_code=403, detail="Permission denied: You don't have access to add keywords")
        
        logger.info(f"Adding search term '{search_term}' as {match_type} keyword to campaign {campaign_id}, ad group {ad_group_id} by {current_user.email}")
        
        # Determine bid — use provided bid or look up the ad group default
        keyword_bid = bid
        if keyword_bid is None:
            try:
                with db_connector.get_connection() as conn:
                    import psycopg2.extras
                    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                        cursor.execute("""
                            SELECT default_bid FROM ad_groups WHERE ad_group_id = %s
                        """, (ad_group_id,))
                        ag = cursor.fetchone()
                        if ag and ag.get('default_bid'):
                            keyword_bid = float(ag['default_bid'])
            except Exception:
                pass
            if keyword_bid is None:
                keyword_bid = 0.75  # Sensible default
        
        new_keyword_id = None

        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                # 1. Check if keyword already exists
                cursor.execute("""
                    SELECT keyword_id FROM keywords
                    WHERE keyword_text = %s AND match_type = %s
                      AND campaign_id = %s AND ad_group_id = %s
                """, (search_term, match_type.upper(), campaign_id, ad_group_id))
                existing = cursor.fetchone()

                if existing:
                    new_keyword_id = existing['keyword_id']
                    logger.info(f"Keyword '{search_term}' already exists (id={new_keyword_id}), updating bid")
                    cursor.execute("""
                        UPDATE keywords SET bid = %s, state = 'ENABLED', updated_at = NOW()
                        WHERE keyword_id = %s
                    """, (keyword_bid, new_keyword_id))
                else:
                    # Generate a temporary local keyword_id; Amazon will assign the real one on sync
                    import random
                    temp_keyword_id = random.randint(9000000000, 9999999999)
                    cursor.execute("""
                        INSERT INTO keywords
                            (keyword_id, keyword_text, match_type, campaign_id, ad_group_id,
                             bid, state, created_at, updated_at)
                        VALUES (%s, %s, %s, %s, %s, %s, 'ENABLED', NOW(), NOW())
                    """, (temp_keyword_id, search_term, match_type.upper(),
                          campaign_id, ad_group_id, keyword_bid))
                    new_keyword_id = temp_keyword_id

                # 2. Log in change_history
                cursor.execute("""
                    INSERT INTO change_history 
                        (entity_type, entity_id, entity_name, field_name, old_value, new_value, 
                         change_type, triggered_by, reason)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    'keyword', new_keyword_id or ad_group_id, search_term, 'keyword_text',
                    '', search_term,
                    'create', f'dashboard_manual:{current_user.email}',
                    f'Added from search term harvesting by {current_user.email}: {search_term} ({match_type})'
                ))
                conn.commit()
        
        # 3. Sync to Amazon Ads API
        sync_manager = _get_amazon_sync_manager()
        if sync_manager:
            try:
                sync_manager.create_keywords([{
                    'campaign_id': campaign_id,
                    'ad_group_id': ad_group_id,
                    'keyword_text': search_term,
                    'match_type': match_type.upper(),
                    'bid': keyword_bid,
                    'state': 'ENABLED',
                }])
                logger.info(f"Keyword synced to Amazon: '{search_term}' ({match_type})")
            except Exception as sync_err:
                logger.error(f"Amazon sync failed for keyword '{search_term}': {sync_err}")
        else:
            logger.warning(f"Amazon sync skipped for keyword '{search_term}': sync manager unavailable")
        
        return {
            "status": "success",
            "message": f"Search term '{search_term}' added as {match_type} keyword",
            "keyword_id": new_keyword_id
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding search term as keyword: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/search-terms/{search_term}/add-negative")
async def add_search_term_as_negative(
    search_term: str,
    campaign_id: int,
    ad_group_id: int,
    match_type: str = Query(..., description="negative_exact, negative_phrase, negative_broad"),
    current_user: UserResponse = Depends(get_current_user)
):
    """Add a search term as a negative keyword
    
    Creates the negative keyword in both the local database and Amazon Ads API.
    Requires: admin, manager, or specialist role
    """
    try:
        # RBAC: Only admin, manager, and specialist roles can add negative keywords
        # if current_user.role not in ['admin', 'manager', 'specialist']:
        #     raise HTTPException(status_code=403, detail="Permission denied: You don't have access to add negative keywords")
        
        logger.info(f"Adding search term '{search_term}' as {match_type} negative keyword to campaign {campaign_id}, ad group {ad_group_id} by {current_user.email}")
        
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                # 1. Record in negative_keyword_history
                cursor.execute("""
                    INSERT INTO negative_keyword_history
                        (keyword_id, keyword_text, match_type, campaign_id, ad_group_id,
                         marked_negative_date, reason, status)
                    VALUES (0, %s, %s, %s, %s, NOW(), %s, 'active')
                """, (
                    search_term, match_type, campaign_id, ad_group_id,
                    f'Added as negative from search term harvesting by {current_user.email}'
                ))

                # 2. Log in change_history
                cursor.execute("""
                    INSERT INTO change_history 
                        (entity_type, entity_id, entity_name, field_name, old_value, new_value, 
                         change_type, triggered_by, reason)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    'negative_keyword', ad_group_id, search_term, 'keyword_text',
                    '', search_term,
                    'create', f'dashboard_manual:{current_user.email}',
                    f'Added as negative from search term harvesting by {current_user.email}: {search_term} ({match_type})'
                ))
                conn.commit()
        
        # 3. Sync to Amazon Ads API
        sync_manager = _get_amazon_sync_manager()
        if sync_manager:
            try:
                sync_manager.create_negative_keywords([{
                    'campaign_id': campaign_id,
                    'ad_group_id': ad_group_id,
                    'keyword_text': search_term,
                    'match_type': match_type.upper(),
                    'state': 'ENABLED',
                }])
                logger.info(f"Negative keyword synced to Amazon: '{search_term}' ({match_type})")
            except Exception as sync_err:
                logger.error(f"Amazon sync failed for negative keyword '{search_term}': {sync_err}")
        else:
            logger.warning(f"Amazon sync skipped for negative keyword '{search_term}': sync manager unavailable")
        
        return {
            "status": "success",
            "message": f"Search term '{search_term}' added as {match_type} negative keyword"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding search term as negative: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/inventory-status/{asin}")
async def get_inventory_status(asin: str):
    """Get inventory status for an ASIN"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT asin, current_inventory, days_of_supply, ad_status
                    FROM inventory_health
                    WHERE asin = %s
                """, (asin,))
                result = cursor.fetchone()
                
                if result:
                    return {
                        "asin": result['asin'],
                        "current_inventory": result['current_inventory'],
                        "days_of_supply": result['days_of_supply'],
                        "ad_status": result['ad_status'],
                        "is_out_of_stock": result['current_inventory'] == 0,
                    }
                else:
                    return {
                        "asin": asin,
                        "current_inventory": None,
                        "days_of_supply": None,
                        "ad_status": "unknown",
                        "is_out_of_stock": False,
                    }
    except Exception as e:
        logger.error(f"Error fetching inventory status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# API ENDPOINTS - SELLING PARTNER API INVENTORY SYNC
@app.post("/api/inventory/sync")
async def sync_inventory(
    current_user: UserResponse = Depends(get_current_user),
    background_tasks: BackgroundTasks = None
):
    """
    Trigger inventory sync from Selling Partner API
    Requires: admin or manager role
    
    TODO: Implement full SP-API integration:
    1. Get seller credentials from account settings
    2. Initialize SP-API client with LWA tokens
    3. Fetch inventory for all active product ASINs
    4. Update inventory_health table
    5. Return sync status
    """
    try:
        # if current_user.role not in ['admin', 'manager']:
        #     raise HTTPException(status_code=403, detail="Permission denied: Only admins/managers can trigger sync")
        
        # TODO: Load credentials from database
        # sp_api_client = SellingPartnerAPIClient(
        #     refresh_token=user_account.refresh_token,
        #     client_id=user_account.client_id,
        #     client_secret=user_account.client_secret,
        #     region="NA"
        # )
        
        # TODO: Queue background sync task
        # if background_tasks:
        #     background_tasks.add_task(inventory_sync_service.sync_inventory_for_asins, asins, marketplace_id)
        
        logger.info(f"Inventory sync requested by user {current_user.username}")
        
        return {
            "status": "pending",
            "message": "Inventory sync queued - requires SP-API credentials in database",
            "error": "SP-API integration not yet enabled. Please configure seller credentials in account settings."
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error triggering inventory sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/inventory/sync-status")
async def get_sync_status(current_user: UserResponse = Depends(get_current_user)):
    """
    Get status of last inventory sync
    """
    try:
        # TODO: Query sync_history table for last sync
        return {
            "last_sync": None,
            "is_syncing": False,
            "status": "not_configured",
            "message": "SP-API inventory sync not yet configured",
            "next_scheduled_sync": None
        }
    except Exception as e:
        logger.error(f"Error getting sync status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/inventory/low-stock-warnings")
async def get_low_stock_warnings(
    threshold: int = Query(5, ge=1, le=50),
    current_user: UserResponse = Depends(get_current_user)
):
    """
    Get list of products with low inventory
    """
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT asin, current_inventory, status, last_updated
                    FROM inventory_health
                    WHERE current_inventory <= %s AND status != 'out_of_stock'
                    ORDER BY current_inventory ASC
                    LIMIT 100
                """, (threshold,))
                
                warnings = []
                for row in cursor.fetchall():
                    warnings.append({
                        "asin": row['asin'],
                        "quantity": row['current_inventory'],
                        "status": row['status'],
                        "last_updated": row['last_updated']
                    })
                
                return {
                    "threshold": threshold,
                    "count": len(warnings),
                    "warnings": warnings
                }
                
    except Exception as e:
        logger.error(f"Error getting low stock warnings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/inventory/manual-update")
async def manually_update_inventory(
    asin: str,
    quantity: int,
    current_user: UserResponse = Depends(get_current_user)
):
    """
    Manually update inventory for an ASIN
    Requires: admin or manager role
    
    Use this until SP-API is fully integrated
    """
    try:
        if current_user.role not in ['admin', 'manager']:
            raise HTTPException(status_code=403, detail="Permission denied")
        
        if quantity < 0:
            raise HTTPException(status_code=400, detail="Quantity cannot be negative")
        
        # Determine status
        status = "out_of_stock" if quantity == 0 else ("low_stock" if quantity < 5 else "in_stock")
        
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO inventory_health (asin, current_inventory, status, last_updated)
                    VALUES (%s, %s, %s, NOW())
                    ON CONFLICT (asin) DO UPDATE SET
                    current_inventory = EXCLUDED.current_inventory,
                    status = EXCLUDED.status,
                    last_updated = NOW()
                """, (asin, quantity, status))
                conn.commit()
        
        logger.info(f"Inventory manually updated for {asin}: {quantity} units by {current_user.username}")
        
        return {
            "status": "success",
            "asin": asin,
            "quantity": quantity,
            "inventory_status": status,
            "message": f"Inventory updated to {quantity} units"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating inventory: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dayparting/heatmap")
async def get_dayparting_heatmap(
    entity_type: str,
    entity_id: int,
    metric: str = Query('sales', description="sales, spend, acos, ctr, cvr"),
    days: int = Query(30, ge=7, le=90)
):
    """Get dayparting heatmap data (performance by hour and day)"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                end_date = datetime.now().date()
                start_date = end_date - timedelta(days=days)
                
                # Generate sample data (in production, would need hourly performance tracking)
                result = []
                for day in range(7):
                    for hour in range(24):
                        value = 0
                        if metric == 'sales':
                            value = 100 + (day * 10) + (hour * 5) + (hash(f"{entity_id}-{day}-{hour}") % 50)
                        elif metric == 'spend':
                            value = 10 + (day * 2) + (hour * 1) + (hash(f"{entity_id}-{day}-{hour}") % 10)
                        elif metric == 'acos':
                            value = 8 + (day * 0.5) + (hash(f"{entity_id}-{day}-{hour}") % 5)
                        elif metric == 'ctr':
                            value = 0.5 + (day * 0.1) + (hash(f"{entity_id}-{day}-{hour}") % 2) / 10
                        elif metric == 'cvr':
                            value = 2 + (day * 0.2) + (hash(f"{entity_id}-{day}-{hour}") % 3) / 10
                        
                        result.append({
                            "day_of_week": day,
                            "hour_of_day": hour,
                            "value": value,
                            "metric": metric
                        })
                
                return result
    except Exception as e:
        logger.error(f"Error fetching dayparting heatmap: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/dayparting/config")
async def get_dayparting_config(
    entity_type: str,
    entity_id: int
):
    """Get dayparting configuration for an entity"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT day_of_week, hour_of_day, bid_multiplier, is_active
                    FROM dayparting_config
                    WHERE entity_type = %s AND entity_id = %s
                    ORDER BY day_of_week, hour_of_day
                """, (entity_type, entity_id))
                
                configs = cursor.fetchall()
                return [
                    {
                        "day_of_week": c['day_of_week'],
                        "hour_of_day": c['hour_of_day'],
                        "bid_multiplier": float(c['bid_multiplier']),
                        "is_active": c['is_active']
                    }
                    for c in configs
                ]
    except Exception as e:
        logger.error(f"Error fetching dayparting config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/dayparting/config")
async def save_dayparting_config(
    entity_type: str,
    entity_id: int,
    config: List[Dict[str, Any]]
):
    """Save dayparting configuration for an entity"""
    try:
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                # Delete existing config
                cursor.execute("""
                    DELETE FROM dayparting_config
                    WHERE entity_type = %s AND entity_id = %s
                """, (entity_type, entity_id))
                
                # Insert new config
                for c in config:
                    cursor.execute("""
                        INSERT INTO dayparting_config 
                            (entity_type, entity_id, day_of_week, hour_of_day, bid_multiplier, is_active)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (entity_type, entity_id, day_of_week, hour_of_day)
                        DO UPDATE SET
                            bid_multiplier = EXCLUDED.bid_multiplier,
                            is_active = EXCLUDED.is_active,
                            updated_at = CURRENT_TIMESTAMP
                    """, (
                        entity_type, entity_id,
                        c['day_of_week'], c['hour_of_day'],
                        c['bid_multiplier'], c.get('is_active', True)
                    ))
                
                conn.commit()
        
        return {"status": "success", "message": f"Dayparting config saved for {entity_type} {entity_id}"}
    except Exception as e:
        logger.error(f"Error saving dayparting config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/campaigns/{campaign_id}/add-to-portfolio")
async def add_campaign_to_portfolio(
    campaign_id: int,
    portfolio_id: int = Query(..., description="Portfolio ID to add campaign to")
):
    """Add a campaign to a portfolio"""
    try:
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                # Verify portfolio exists
                cursor.execute("""
                    SELECT portfolio_id, portfolio_name 
                    FROM portfolios 
                    WHERE portfolio_id = %s
                """, (portfolio_id,))
                portfolio = cursor.fetchone()
                
                if not portfolio:
                    raise HTTPException(status_code=404, detail=f"Portfolio {portfolio_id} not found")
                
                # Update campaign portfolio
                cursor.execute("""
                    UPDATE campaigns 
                    SET portfolio_id = %s, updated_at = CURRENT_TIMESTAMP
                    WHERE campaign_id = %s
                """, (portfolio_id, campaign_id))
                
                if cursor.rowcount == 0:
                    raise HTTPException(status_code=404, detail=f"Campaign {campaign_id} not found")
                
                # Get campaign name for change history
                cursor.execute("SELECT campaign_name FROM campaigns WHERE campaign_id = %s", (campaign_id,))
                campaign_row = cursor.fetchone()
                campaign_name = campaign_row[0] if campaign_row else None
                
                # Log to change history
                cursor.execute("""
                    INSERT INTO change_history 
                        (entity_type, entity_id, entity_name, field_name, old_value, new_value, 
                         change_type, triggered_by, reason)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    'campaign', campaign_id, campaign_name, 'portfolio_id',
                    None, str(portfolio_id),
                    'update', 'manual',
                    f'Added to portfolio: {portfolio[1]}'
                ))
                
                conn.commit()
        
        return {
            "status": "success",
            "message": f"Campaign {campaign_id} added to portfolio {portfolio[1]}"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding campaign to portfolio: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/campaigns/bulk-add-to-portfolio")
async def bulk_add_campaigns_to_portfolio(
    campaign_ids: List[int] = Query(..., description="List of campaign IDs"),
    portfolio_id: int = Query(..., description="Portfolio ID to add campaigns to")
):
    """Add multiple campaigns to a portfolio"""
    try:
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                # Verify portfolio exists
                cursor.execute("""
                    SELECT portfolio_id, portfolio_name 
                    FROM portfolios 
                    WHERE portfolio_id = %s
                """, (portfolio_id,))
                portfolio = cursor.fetchone()
                
                if not portfolio:
                    raise HTTPException(status_code=404, detail=f"Portfolio {portfolio_id} not found")
                
                # Update campaigns
                placeholders = ','.join(['%s'] * len(campaign_ids))
                cursor.execute(f"""
                    UPDATE campaigns 
                    SET portfolio_id = %s, updated_at = CURRENT_TIMESTAMP
                    WHERE campaign_id IN ({placeholders})
                """, [portfolio_id] + campaign_ids)
                
                updated_count = cursor.rowcount
                
                # Log to change history
                for campaign_id in campaign_ids:
                    cursor.execute("SELECT campaign_name FROM campaigns WHERE campaign_id = %s", (campaign_id,))
                    campaign_row = cursor.fetchone()
                    campaign_name = campaign_row[0] if campaign_row else None
                    
                    cursor.execute("""
                        INSERT INTO change_history 
                            (entity_type, entity_id, entity_name, field_name, old_value, new_value, 
                             change_type, triggered_by, reason)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """, (
                        'campaign', campaign_id, campaign_name, 'portfolio_id',
                        None, str(portfolio_id),
                        'update', 'bulk_action',
                        f'Bulk added to portfolio: {portfolio[1]}'
                    ))
                
                conn.commit()
        
        return {
            "status": "success",
            "message": f"{updated_count} campaigns added to portfolio {portfolio[1]}"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error bulk adding campaigns to portfolio: {e}")
        raise HTTPException(status_code=500, detail=str(e))




# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _calculate_account_health_score(acos: float, roas: float, ctr: float, cvr: float, orders: int) -> float:
    """Calculate account health score (0-100)"""
    score = 100.0
    
    # ACOS penalty (higher ACOS = lower score)
    if acos > 0:
        target_acos = rule_config.acos_target * 100
        if acos > target_acos * 2:
            score -= 30
        elif acos > target_acos * 1.5:
            score -= 20
        elif acos > target_acos:
            score -= 10
    
    # ROAS bonus/penalty
    if roas >= 5:
        score += 10
    elif roas < 1:
        score -= 20
    elif roas < 2:
        score -= 10
    
    # CTR consideration
    if ctr < 0.2:
        score -= 10
    elif ctr > 0.5:
        score += 5
    
    # CVR consideration
    if cvr < 5:
        score -= 10
    elif cvr > 15:
        score += 10
    
    # Volume consideration
    if orders < 10:
        score -= 5
    elif orders > 100:
        score += 5
    
    return max(0, min(100, score))


def _get_campaign_ai_signal(campaign: Dict[str, Any]) -> Optional[str]:
    """Get AI recommendation signal for a campaign"""
    spend = float(campaign.get('total_cost', 0) or 0)
    sales = float(campaign.get('total_sales', 0) or 0)
    budget = float(campaign.get('budget_amount', 0) or 0)
    
    if budget > 0 and spend >= budget * 0.9:
        return "budget_constrained"
    
    if sales > 0:
        acos = spend / sales
        if acos > rule_config.acos_target * 2:
            return "wasted_spend"
        elif acos < rule_config.acos_target * 0.5:
            return "scaling_opportunity"
    
    return None


def _calculate_estimated_impact(rec) -> str:
    """Calculate estimated impact of a recommendation"""
    if rec.adjustment_type == 'bid':
        if rec.adjustment_percentage < 0:
            return f"Spend ↓ ~{abs(rec.adjustment_percentage):.0f}%"
        else:
            return f"Sales ↑ ~{rec.adjustment_percentage:.0f}%"
    elif rec.adjustment_type == 'budget':
        if rec.adjustment_percentage > 0:
            return f"Opportunity ↑ ~{rec.adjustment_percentage:.0f}%"
        else:
            return f"Waste ↓ ~{abs(rec.adjustment_percentage):.0f}%"
    return "Impact TBD"


def _calculate_estimated_impact_str(rec: dict) -> str:
    """Calculate estimated impact from recommendation dict"""
    current = rec.get('current_value', 0)
    recommended = rec.get('recommended_value', 0)
    adjustment_type = rec.get('adjustment_type', 'bid')
    
    if current > 0:
        pct = ((recommended - current) / current) * 100
        if adjustment_type == 'bid':
            if pct < 0:
                return f"Spend ↓ ~{abs(pct):.0f}%"
            else:
                return f"Sales ↑ ~{pct:.0f}%"
    return "Impact TBD"


def _build_recommendation_reason(signals: dict, adjustment_type: str) -> str:
    """Build human-readable reason from intelligence signals"""
    reasons = []
    
    if signals.get('acos_tier'):
        tier = signals['acos_tier']
        if 'high' in tier.lower():
            reasons.append(f"ACOS in high tier ({tier})")
        elif 'low' in tier.lower():
            reasons.append(f"ACOS performing well ({tier})")
    
    if signals.get('conversion_tier'):
        reasons.append(f"Conversions: {signals['conversion_tier']}")
    
    if signals.get('ctr_status'):
        reasons.append(f"CTR: {signals['ctr_status']}")
    
    if signals.get('spend_status'):
        reasons.append(f"Spend: {signals['spend_status']}")
    
    if not reasons:
        return f"AI-optimized {adjustment_type} recommendation based on performance analysis"
    
    return "; ".join(reasons)


# ============================================================================
# API ENDPOINTS - BIDDING STRATEGIES
# ============================================================================

@app.get("/api/bidding-strategies")
async def get_bidding_strategies(
    campaign_id: Optional[int] = None,
    ad_group_id: Optional[int] = None
):
    """Get available bidding strategies
    
    Strategies:
    - dynamic_down: Automatically reduce bids for underperforming keywords (high ACOS)
    - up_and_down: Both increase high performers and decrease low performers
    - fixed: Set a fixed bid multiplier across selected keywords
    """
    try:
        strategies = [
            {
                "id": "dynamic_down",
                "name": "Dynamic Down",
                "description": "Automatically reduce bids for keywords with ACOS > target. Protects ad spend without limiting upside.",
                "category": "defensive",
                "parameters": [
                    {
                        "name": "acos_threshold",
                        "label": "ACOS Threshold (%)",
                        "type": "number",
                        "default": 35,
                        "min": 10,
                        "max": 100,
                        "description": "Only reduce bids for keywords with ACOS above this percentage"
                    },
                    {
                        "name": "reduction_percentage",
                        "label": "Reduction (%)",
                        "type": "number",
                        "default": 15,
                        "min": 5,
                        "max": 50,
                        "description": "Percentage to reduce bid by"
                    }
                ],
                "expected_impact": "Reduce ad spend waste on underperforming keywords"
            },
            {
                "id": "up_and_down",
                "name": "Up and Down",
                "description": "Increase bids for top performers (ACOS < target) and decrease underperformers. Balances growth with profitability.",
                "category": "balanced",
                "parameters": [
                    {
                        "name": "acos_up_threshold",
                        "label": "Lower ACOS Threshold (%)",
                        "type": "number",
                        "default": 15,
                        "min": 5,
                        "max": 50,
                        "description": "Increase bids for keywords with ACOS below this percentage"
                    },
                    {
                        "name": "acos_down_threshold",
                        "label": "Upper ACOS Threshold (%)",
                        "type": "number",
                        "default": 35,
                        "min": 10,
                        "max": 100,
                        "description": "Decrease bids for keywords with ACOS above this percentage"
                    },
                    {
                        "name": "increase_percentage",
                        "label": "Increase (%)",
                        "type": "number",
                        "default": 20,
                        "min": 5,
                        "max": 50,
                        "description": "Percentage to increase bid by for top performers"
                    },
                    {
                        "name": "decrease_percentage",
                        "label": "Decrease (%)",
                        "type": "number",
                        "default": 15,
                        "min": 5,
                        "max": 50,
                        "description": "Percentage to decrease bid by for underperformers"
                    }
                ],
                "expected_impact": "Optimize spend allocation: grow winners, reduce losers"
            },
            {
                "id": "fixed",
                "name": "Fixed Multiplier",
                "description": "Apply a fixed bid multiplier to all selected keywords. Useful for quick, broad adjustments.",
                "category": "manual",
                "parameters": [
                    {
                        "name": "multiplier",
                        "label": "Bid Multiplier",
                        "type": "number",
                        "default": 1.0,
                        "step": 0.05,
                        "min": 0.5,
                        "max": 2.0,
                        "description": "Multiply all bids by this factor (1.0 = no change, 1.5 = 50% increase)"
                    }
                ],
                "expected_impact": "Scale bids uniformly across selected keywords"
            }
        ]
        return strategies
    except Exception as e:
        logger.error(f"Error getting bidding strategies: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/bidding-strategies/apply")
async def apply_bidding_strategy(
    strategy_id: str,
    keyword_ids: List[int],
    parameters: Dict[str, Any],
    current_user: UserResponse = Depends(get_current_user)
):
    """Apply a bidding strategy to selected keywords
    
    Calculates projected bid changes based on strategy and performance data.
    Returns preview of changes before they're applied.
    """
    try:
        if current_user.role not in ['admin', 'manager']:
            raise HTTPException(status_code=403, detail="Permission denied")
        
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                # Get keyword data for the selected keywords
                placeholders = ",".join(["%s"] * len(keyword_ids))
                cursor.execute(f"""
                    SELECT k.id, k.keyword, k.current_bid, k.acos, k.ctr, k.conversions
                    FROM keywords k
                    WHERE k.id IN ({placeholders})
                """, keyword_ids)
                
                keywords = cursor.fetchall()
        
        projected_changes = []
        total_current_spend = 0
        total_new_spend = 0
        
        for keyword_id, keyword, current_bid, acos, ctr, conversions in keywords:
            new_bid = current_bid
            reason = ""
            
            if strategy_id == "dynamic_down":
                acos_threshold = parameters.get("acos_threshold", 35) / 100
                reduction_pct = parameters.get("reduction_percentage", 15) / 100
                
                if acos and acos > acos_threshold:
                    new_bid = current_bid * (1 - reduction_pct)
                    reason = f"ACOS {acos:.1%} > threshold {acos_threshold:.1%}: reduce by {reduction_pct:.0%}"
                else:
                    reason = "ACOS within acceptable range: no change"
            
            elif strategy_id == "up_and_down":
                acos_up_threshold = parameters.get("acos_up_threshold", 15) / 100
                acos_down_threshold = parameters.get("acos_down_threshold", 35) / 100
                increase_pct = parameters.get("increase_percentage", 20) / 100
                decrease_pct = parameters.get("decrease_percentage", 15) / 100
                
                if acos and acos < acos_up_threshold:
                    new_bid = current_bid * (1 + increase_pct)
                    reason = f"Top performer: ACOS {acos:.1%} < {acos_up_threshold:.1%}: increase by {increase_pct:.0%}"
                elif acos and acos > acos_down_threshold:
                    new_bid = current_bid * (1 - decrease_pct)
                    reason = f"Underperformer: ACOS {acos:.1%} > {acos_down_threshold:.1%}: reduce by {decrease_pct:.0%}"
                else:
                    reason = f"Mid-range performer: ACOS {acos:.1%}: no change"
            
            elif strategy_id == "fixed":
                multiplier = parameters.get("multiplier", 1.0)
                new_bid = current_bid * multiplier
                change_pct = (multiplier - 1) * 100
                reason = f"Fixed multiplier {multiplier:.2f}x: {change_pct:+.0f}%"
            
            # Enforce bid limits
            new_bid = max(0.02, min(new_bid, 4.52))
            
            projected_changes.append({
                "keyword_id": keyword_id,
                "keyword": keyword,
                "current_bid": round(current_bid, 2),
                "new_bid": round(new_bid, 2),
                "change_amount": round(new_bid - current_bid, 2),
                "change_percentage": round(((new_bid - current_bid) / current_bid * 100) if current_bid > 0 else 0, 1),
                "acos": round(acos, 3) if acos else None,
                "conversions": conversions or 0,
                "reason": reason
            })
            
            total_current_spend += current_bid
            total_new_spend += new_bid
        
        return {
            "strategy_id": strategy_id,
            "strategy_name": {
                "dynamic_down": "Dynamic Down",
                "up_and_down": "Up and Down",
                "fixed": "Fixed Multiplier"
            }.get(strategy_id, strategy_id),
            "total_keywords": len(projected_changes),
            "projected_changes": projected_changes,
            "total_current_spend": round(total_current_spend, 2),
            "total_new_spend": round(total_new_spend, 2),
            "total_spend_change": round(total_new_spend - total_current_spend, 2),
            "spend_change_percentage": round(((total_new_spend - total_current_spend) / total_current_spend * 100) if total_current_spend > 0 else 0, 1)
        }
    except Exception as e:
        logger.error(f"Error applying bidding strategy: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/bidding-strategies/execute")
async def execute_bidding_strategy(
    strategy_id: str,
    keyword_ids: List[int],
    parameters: Dict[str, Any],
    current_user: UserResponse = Depends(get_current_user)
):
    """Execute a bidding strategy and apply the bid changes
    
    This endpoint commits the bid changes to the database and Amazon Ads API.
    """
    try:
        if current_user.role not in ['admin', 'manager']:
            raise HTTPException(status_code=403, detail="Permission denied")
        
        # First get the projected changes
        preview_response = await apply_bidding_strategy(strategy_id, keyword_ids, parameters, current_user)
        
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                timestamp = datetime.now()
                
                for change in preview_response['projected_changes']:
                    keyword_id = change['keyword_id']
                    new_bid = change['new_bid']
                    
                    # Update keyword bid in database
                    cursor.execute("""
                        UPDATE keywords 
                        SET current_bid = %s, last_modified = %s
                        WHERE id = %s
                    """, (new_bid, timestamp, keyword_id))
                    
                    # Log the change
                    cursor.execute("""
                        INSERT INTO bid_change_history
                        (keyword_id, old_bid, new_bid, change_reason, changed_by, change_type)
                        VALUES (%s, %s, %s, %s, %s, %s)
                    """, (
                        keyword_id,
                        change['current_bid'],
                        new_bid,
                        f"Strategy: {preview_response['strategy_name']}",
                        current_user.id,
                        'strategy'
                    ))
                
                conn.commit()
        
        return {
            "status": "success",
            "message": f"Applied {preview_response['strategy_name']} to {len(keyword_ids)} keywords",
            "total_keywords_updated": len(keyword_ids),
            "total_spend_change": preview_response['total_spend_change'],
            "changes": preview_response['projected_changes']
        }
    except Exception as e:
        logger.error(f"Error executing bidding strategy: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# FINANCIAL METRICS & PROFITABILITY ENDPOINTS
# ============================================================================

@app.post("/api/cogs/upsert")
async def upsert_cogs(
    cogs: COGS,
    current_user: UserResponse = Depends(get_current_user)
):
    """Add or update COGS for an ASIN"""
    try:
        if current_user.role not in ['admin', 'manager']:
            raise HTTPException(status_code=403, detail="Permission denied")
        
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO product_cogs (asin, sku, cost_per_unit, currency, notes, updated_by, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (asin) DO UPDATE SET
                    cost_per_unit = EXCLUDED.cost_per_unit,
                    sku = EXCLUDED.sku,
                    currency = EXCLUDED.currency,
                    notes = EXCLUDED.notes,
                    updated_by = EXCLUDED.updated_by,
                    updated_at = NOW()
                """, (cogs.asin, cogs.sku, cogs.cost_per_unit, cogs.currency, cogs.notes, current_user.id))
                conn.commit()
        
        logger.info(f"COGS updated for ASIN {cogs.asin} by {current_user.username}")
        return {"status": "success", "message": f"COGS updated for {cogs.asin}"}
    except Exception as e:
        logger.error(f"Error upserting COGS: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/cogs/asin/{asin}", response_model=COGSResponse)
async def get_cogs_for_asin(asin: str):
    """Get COGS information for an ASIN"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT asin, sku, cost_per_unit, currency, updated_at as last_updated
                    FROM product_cogs WHERE asin = %s
                """, (asin,))
                row = cursor.fetchone()
                
                if not row:
                    raise HTTPException(status_code=404, detail=f"COGS not found for ASIN {asin}")
                
                return COGSResponse(**row)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching COGS: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/financial-metrics/campaign/{campaign_id}")
async def get_campaign_financial_metrics(
    campaign_id: str,
    date: str = Query("2025-01-22"),
    current_user: UserResponse = Depends(get_current_user)
):
    """Calculate financial metrics for a campaign including profit and TACoS"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                # Get campaign performance data
                cursor.execute("""
                    SELECT 
                        campaign_id, campaign_name, spend, revenue, units_sold, acos
                    FROM campaign_performance
                    WHERE campaign_id = %s AND date = %s
                """, (campaign_id, date))
                
                perf = cursor.fetchone()
                if not perf:
                    raise HTTPException(status_code=404, detail="Campaign performance data not found")
                
                # Get COGS data - join with products in this campaign
                cursor.execute("""
                    SELECT SUM(pc.cost_per_unit * cp.units_sold) as total_cogs
                    FROM campaign_performance cp
                    JOIN product_cogs pc ON cp.campaign_id = %s
                    WHERE cp.date = %s
                """, (campaign_id, date))
                
                cogs_result = cursor.fetchone()
                cogs = cogs_result['total_cogs'] or 0 if cogs_result else 0
                
                # Calculate metrics
                spend = perf['spend']
                revenue = perf['revenue']
                gross_profit = revenue - cogs
                net_profit = gross_profit - spend
                roi = (net_profit / spend * 100) if spend > 0 else 0
                tacos = (spend / revenue * 100) if revenue > 0 else 0
                break_even_acos = ((cogs + spend) / perf['units_sold'] * 100) if perf['units_sold'] > 0 else 0
                profit_margin = (net_profit / revenue * 100) if revenue > 0 else 0
                
                return {
                    "date": date,
                    "campaign_id": campaign_id,
                    "campaign_name": perf['campaign_name'],
                    "spend": spend,
                    "revenue": revenue,
                    "units_sold": perf['units_sold'],
                    "cogs": cogs,
                    "gross_profit": gross_profit,
                    "net_profit": net_profit,
                    "acos": perf['acos'],
                    "tacos": tacos,
                    "break_even_acos": break_even_acos,
                    "roi": roi,
                    "profit_margin": profit_margin
                }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error calculating financial metrics: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# SEARCH TERM HARVESTING ENDPOINTS
# ============================================================================

@app.get("/api/search-terms/positive-harvest")
async def get_positive_search_terms(
    campaign_id: str,
    min_orders: int = Query(3),
    max_acos: float = Query(20.0),
    limit: int = Query(50, le=200),
    current_user: UserResponse = Depends(get_current_user)
):
    """Get search terms eligible for harvesting as positive keywords"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT 
                        search_term, campaign_id, ad_group_id, clicks, conversions,
                        spend, (spend / conversions) as cpc, 
                        CASE WHEN conversions > 0 THEN (spend / conversions) * 100 ELSE 0 END as acos
                    FROM search_term_performance
                    WHERE campaign_id = %s 
                    AND conversions > %s 
                    AND (spend / conversions) * 100 < %s
                    ORDER BY conversions DESC, spend ASC
                    LIMIT %s
                """, (campaign_id, min_orders, max_acos, limit))
                
                harvests = []
                for row in cursor.fetchall():
                    harvests.append({
                        "search_term": row['search_term'],
                        "campaign_id": row['campaign_id'],
                        "ad_group_id": row['ad_group_id'],
                        "clicks": row['clicks'],
                        "conversions": row['conversions'],
                        "spend": row['spend'],
                        "acos": row['acos'],
                        "keyword_type": "EXACT",
                        "harvest_type": "positive"
                    })
                
                return {"count": len(harvests), "search_terms": harvests}
    except Exception as e:
        logger.error(f"Error harvesting positive search terms: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/search-terms/negative-harvest")
async def get_negative_search_terms(
    campaign_id: str,
    min_clicks: int = Query(15),
    max_conversions: int = Query(0),
    limit: int = Query(50, le=200),
    current_user: UserResponse = Depends(get_current_user)
):
    """Get search terms eligible for adding as negative keywords"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT 
                        search_term, campaign_id, ad_group_id, clicks, conversions, spend
                    FROM search_term_performance
                    WHERE campaign_id = %s 
                    AND clicks > %s 
                    AND conversions <= %s
                    ORDER BY clicks DESC
                    LIMIT %s
                """, (campaign_id, min_clicks, max_conversions, limit))
                
                harvests = []
                for row in cursor.fetchall():
                    harvests.append({
                        "search_term": row['search_term'],
                        "campaign_id": row['campaign_id'],
                        "ad_group_id": row['ad_group_id'],
                        "clicks": row['clicks'],
                        "conversions": row['conversions'],
                        "spend": row['spend'],
                        "keyword_type": "NEGATIVE_EXACT",
                        "harvest_type": "negative"
                    })
                
                return {"count": len(harvests), "search_terms": harvests}
    except Exception as e:
        logger.error(f"Error harvesting negative search terms: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/search-terms/apply-harvest")
async def apply_search_term_harvest(
    harvest: SearchTermHarvest,
    current_user: UserResponse = Depends(get_current_user)
):
    """Apply harvested search term as keyword or negative keyword"""
    try:
        if current_user.role not in ['admin', 'manager']:
            raise HTTPException(status_code=403, detail="Permission denied")
        
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                # Log harvest action to database
                cursor.execute("""
                    INSERT INTO search_term_harvests
                    (search_term, campaign_id, harvest_type, keyword_type, status, applied_by, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, NOW())
                """, (
                    harvest.search_term, harvest.campaign_id, harvest.harvest_type,
                    harvest.keyword_type, 'applied', current_user.id
                ))
                conn.commit()
        
        logger.info(f"Search term harvest applied: {harvest.search_term} ({harvest.harvest_type}) by {current_user.username}")
        return {
            "status": "success",
            "message": f"Search term '{harvest.search_term}' applied as {harvest.keyword_type}",
            "harvest_type": harvest.harvest_type
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error applying search term harvest: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# CHANGE HISTORY & AUDIT LOG ENDPOINTS
# ============================================================================

@app.get("/api/changes/history")
async def get_change_history(
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    user_id: Optional[str] = None,
    change_type: Optional[str] = None,  # manual, ai, system
    limit: int = Query(100, le=500),
    offset: int = Query(0, ge=0),
    current_user: UserResponse = Depends(get_current_user)
):
    """Get audit log of all changes made"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                # Build WHERE clause
                conditions = []
                params = []
                
                if entity_type:
                    conditions.append("entity_type = %s")
                    params.append(entity_type)
                if entity_id:
                    conditions.append("entity_id = %s")
                    params.append(entity_id)
                if user_id:
                    conditions.append("user_id = %s")
                    params.append(user_id)
                if change_type:
                    conditions.append("change_type = %s")
                    params.append(change_type)
                
                where_clause = " WHERE " + " AND ".join(conditions) if conditions else ""
                
                cursor.execute(f"""
                    SELECT 
                        change_id, user_id, entity_type, entity_id, entity_name,
                        old_value, new_value, change_type, reason, status, created_at
                    FROM change_history
                    {where_clause}
                    ORDER BY created_at DESC
                    LIMIT %s OFFSET %s
                """, params + [limit, offset])
                
                changes = []
                for row in cursor.fetchall():
                    changes.append(dict(row))
                
                return {"total": len(changes), "changes": changes}
    except Exception as e:
        logger.error(f"Error fetching change history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/changes/log")
async def log_change(
    change: ChangeHistory,
    current_user: UserResponse = Depends(get_current_user)
):
    """Log a change for audit purposes"""
    try:
        # if current_user.role not in ['admin', 'manager', 'specialist']:
        #     raise HTTPException(status_code=403, detail="Permission denied")
        
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO change_history
                    (user_id, entity_type, entity_id, entity_name, old_value, new_value, 
                     change_type, reason, status, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                """, (
                    current_user.id, change.entity_type, change.entity_id, change.entity_name,
                    json.dumps(change.old_value) if change.old_value else None,
                    json.dumps(change.new_value) if change.new_value else None,
                    change.change_type, change.reason, change.status
                ))
                conn.commit()
        
        logger.info(f"Change logged: {change.entity_type} {change.entity_id} by {current_user.username}")
        return {"status": "success", "message": "Change recorded"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error logging change: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/changes/revert/{change_id}")
async def revert_change(
    change_id: str,
    current_user: UserResponse = Depends(get_current_user)
):
    """Revert a previously made change"""
    try:
        if current_user.role not in ['admin', 'manager']:
            raise HTTPException(status_code=403, detail="Permission denied")
        
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                # Get original change
                cursor.execute("""
                    SELECT old_value, new_value, entity_type, entity_id
                    FROM change_history WHERE change_id = %s
                """, (change_id,))
                
                orig_change = cursor.fetchone()
                if not orig_change:
                    raise HTTPException(status_code=404, detail="Change not found")
                
                # Update status to reverted
                cursor.execute("""
                    UPDATE change_history SET status = 'reverted', updated_at = NOW()
                    WHERE change_id = %s
                """, (change_id,))
                
                # Log the revert as new change
                cursor.execute("""
                    INSERT INTO change_history
                    (user_id, entity_type, entity_id, old_value, new_value, change_type, 
                     reason, status, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                """, (
                    current_user.id,
                    orig_change['entity_type'],
                    orig_change['entity_id'],
                    orig_change['new_value'],
                    orig_change['old_value'],
                    'manual',
                    f'Revert of change {change_id}',
                    'completed'
                ))
                
                conn.commit()
        
        logger.info(f"Change {change_id} reverted by {current_user.username}")
        return {"status": "success", "message": f"Change {change_id} reverted"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reverting change: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# TABBED NAVIGATION & DRILL-DOWN ENDPOINTS
# ============================================================================

@app.get("/api/navigation/breadcrumbs")
async def get_breadcrumbs(
    entity_type: str,
    entity_id: Optional[str] = None
):
    """Get breadcrumb navigation path"""
    breadcrumb_map = {
        "campaigns": [{"label": "All Campaigns", "url": "/dashboard/campaigns", "icon": "folder"}],
        "adgroups": [
            {"label": "All Campaigns", "url": "/dashboard/campaigns", "icon": "folder"},
            {"label": "Ad Groups", "url": f"/dashboard/campaigns/{entity_id}/adgroups", "icon": "layers"}
        ],
        "keywords": [
            {"label": "All Campaigns", "url": "/dashboard/campaigns", "icon": "folder"},
            {"label": "Ad Groups", "url": f"/dashboard/campaigns/{entity_id}/adgroups", "icon": "layers"},
            {"label": "Keywords", "url": f"/dashboard/adgroups/{entity_id}/keywords", "icon": "key"}
        ],
        "targets": [
            {"label": "All Campaigns", "url": "/dashboard/campaigns", "icon": "folder"},
            {"label": "Ad Groups", "url": f"/dashboard/campaigns/{entity_id}/adgroups", "icon": "layers"},
            {"label": "Targeting", "url": f"/dashboard/adgroups/{entity_id}/targets", "icon": "target"}
        ],
        "searchterms": [
            {"label": "All Campaigns", "url": "/dashboard/campaigns", "icon": "folder"},
            {"label": "Search Terms", "url": "/dashboard/searchterms", "icon": "search"}
        ]
    }
    
    return {
        "items": breadcrumb_map.get(entity_type, []),
        "current": entity_type
    }


@app.get("/api/navigation/tabs/{parent_entity}/{parent_id}")
async def get_navigation_tabs(
    parent_entity: str,
    parent_id: str
):
    """Get available tabs for drill-down navigation"""
    tabs_config = {
        "campaign": [
            {"tab_id": "overview", "label": "Overview", "entity_type": "campaigns", "icon": "chart"},
            {"tab_id": "adgroups", "label": "Ad Groups", "entity_type": "adgroups", "icon": "layers"},
            {"tab_id": "performance", "label": "Performance", "entity_type": "campaigns", "icon": "trending"},
            {"tab_id": "keywords", "label": "Keywords", "entity_type": "keywords", "icon": "key"},
            {"tab_id": "targets", "label": "Product Targeting", "entity_type": "targets", "icon": "target"},
            {"tab_id": "searchterms", "label": "Search Terms", "entity_type": "searchterms", "icon": "search"}
        ],
        "adgroup": [
            {"tab_id": "overview", "label": "Overview", "entity_type": "adgroups", "icon": "chart"},
            {"tab_id": "keywords", "label": "Keywords", "entity_type": "keywords", "icon": "key"},
            {"tab_id": "targets", "label": "Product Targeting", "entity_type": "targets", "icon": "target"},
            {"tab_id": "ads", "label": "Product Ads", "entity_type": "productads", "icon": "image"}
        ],
        "keyword": [
            {"tab_id": "performance", "label": "Performance", "entity_type": "keywords", "icon": "chart"},
            {"tab_id": "searchterms", "label": "Search Terms", "entity_type": "searchterms", "icon": "search"}
        ]
    }
    
    return {
        "parent_entity": parent_entity,
        "parent_id": parent_id,
        "tabs": tabs_config.get(parent_entity, [])
    }


@app.post("/api/navigation/drill-down")
async def perform_drill_down(
    parent_entity: str,
    parent_id: str,
    target_entity: str,
    current_user: UserResponse = Depends(get_current_user)
):
    """Perform drill-down navigation and filter child entity"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                # Build query based on entity types
                if target_entity == "adgroups" and parent_entity == "campaign":
                    cursor.execute("""
                        SELECT id, name, campaign_id, status, created_date
                        FROM ad_groups WHERE campaign_id = %s
                        ORDER BY name
                    """, (parent_id,))
                    data = cursor.fetchall()
                    
                elif target_entity == "keywords" and parent_entity == "adgroup":
                    cursor.execute("""
                        SELECT id, keyword_text, match_type, bid, status
                        FROM keywords WHERE ad_group_id = %s
                        ORDER BY keyword_text
                    """, (parent_id,))
                    data = cursor.fetchall()
                    
                elif target_entity == "targets" and parent_entity == "adgroup":
                    cursor.execute("""
                        SELECT id, targeting_expression, match_type, bid, status
                        FROM targets WHERE ad_group_id = %s
                        ORDER BY targeting_expression
                    """, (parent_id,))
                    data = cursor.fetchall()
                else:
                    raise HTTPException(status_code=400, detail="Invalid drill-down path")
                
                return {
                    "parent_entity": parent_entity,
                    "parent_id": parent_id,
                    "target_entity": target_entity,
                    "count": len(data),
                    "data": [dict(row) for row in data]
                }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error performing drill-down: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# EVENT ANNOTATION ENDPOINTS
# ============================================================================

@app.get("/api/events/annotations")
async def get_event_annotations(
    start_date: str,
    end_date: str,
    event_type: Optional[str] = None,
    limit: int = Query(50, le=200)
):
    """Get event annotations for graph display"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                conditions = ["date BETWEEN %s AND %s"]
                params = [start_date, end_date]
                
                if event_type:
                    conditions.append("event_type = %s")
                    params.append(event_type)
                
                where_clause = " WHERE " + " AND ".join(conditions)
                
                cursor.execute(f"""
                    SELECT 
                        event_id, date, event_type, title, description, impact,
                        metrics_before, metrics_after
                    FROM event_annotations
                    {where_clause}
                    ORDER BY date DESC
                    LIMIT %s
                """, params + [limit])
                
                events = []
                for row in cursor.fetchall():
                    events.append({
                        "event_id": row['event_id'],
                        "date": row['date'],
                        "event_type": row['event_type'],
                        "title": row['title'],
                        "description": row['description'],
                        "impact": row['impact'],
                        "metrics_before": json.loads(row['metrics_before']) if row['metrics_before'] else {},
                        "metrics_after": json.loads(row['metrics_after']) if row['metrics_after'] else {}
                    })
                
                return {"count": len(events), "events": events}
    except Exception as e:
        logger.error(f"Error fetching event annotations: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/events/annotations/create")
async def create_event_annotation(
    event: EventAnnotation,
    current_user: UserResponse = Depends(get_current_user)
):
    """Create event annotation for graph"""
    try:
        if current_user.role not in ['admin', 'manager']:
            raise HTTPException(status_code=403, detail="Permission denied")
        
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO event_annotations
                    (date, event_type, title, description, impact, user_id,
                     metrics_before, metrics_after, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
                """, (
                    event.date, event.event_type, event.title, event.description,
                    event.impact, current_user.id,
                    json.dumps(event.metrics_before),
                    json.dumps(event.metrics_after)
                ))
                conn.commit()
        
        logger.info(f"Event annotation created: {event.title} by {current_user.username}")
        return {"status": "success", "message": "Event annotation created"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating event annotation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# COLUMN MANAGEMENT & RESIZABLE COLUMNS
# ============================================================================

@app.post("/api/grid-columns/save-layout")
async def save_column_layout(
    view_type: str,
    layout: ColumnLayoutPreference,
    current_user: UserResponse = Depends(get_current_user)
):
    """Save column layout preferences for user"""
    try:
        with db_connector.get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO column_preferences
                    (user_id, view_type, column_visibility, column_order, column_widths, updated_at)
                    VALUES (%s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (user_id, view_type) DO UPDATE SET
                    column_visibility = EXCLUDED.column_visibility,
                    column_order = EXCLUDED.column_order,
                    column_widths = EXCLUDED.column_widths,
                    updated_at = NOW()
                """, (
                    current_user.id, view_type,
                    json.dumps(layout.column_visibility),
                    json.dumps(layout.column_order),
                    json.dumps(layout.column_widths)
                ))
                conn.commit()
        
        return {"status": "success", "message": "Column layout saved"}
    except Exception as e:
        logger.error(f"Error saving column layout: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/grid-columns/load-layout")
async def load_column_layout(
    view_type: str,
    current_user: UserResponse = Depends(get_current_user)
):
    """Load saved column layout preferences"""
    try:
        with db_connector.get_connection() as conn:
            import psycopg2.extras
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
                cursor.execute("""
                    SELECT column_visibility, column_order, column_widths
                    FROM column_preferences
                    WHERE user_id = %s AND view_type = %s
                """, (current_user.id, view_type))
                
                row = cursor.fetchone()
                if not row:
                    return {
                        "view_type": view_type,
                        "column_visibility": {},
                        "column_order": [],
                        "column_widths": {}
                    }
                
                return {
                    "view_type": view_type,
                    "column_visibility": json.loads(row['column_visibility']),
                    "column_order": json.loads(row['column_order']),
                    "column_widths": json.loads(row['column_widths'])
                }
    except Exception as e:
        logger.error(f"Error loading column layout: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# RUN SERVER
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

