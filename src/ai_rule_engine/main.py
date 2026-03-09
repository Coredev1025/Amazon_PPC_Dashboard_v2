#!/usr/bin/env python3
"""
Main script for AI Rule Engine
Usage: python -m src.ai_rule_engine.main [options]
"""

import argparse
import logging
import sys
import os
import time
from datetime import datetime
from typing import List, Optional
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Add parent directory to path for imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ai_rule_engine import AIRuleEngine, RuleConfig, DatabaseConnector
from ai_rule_engine.recommendations import Recommendation
from ai_rule_engine.amazon_sync import AmazonSyncManager


def setup_logging(level: str = 'INFO') -> None:
    """Setup logging configuration"""
    log_level = getattr(logging, level.upper(), logging.INFO)
    
    logging.basicConfig(
        level=log_level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(f'logs/ai_rule_engine_{datetime.now().strftime("%Y%m%d")}.log')
        ]
    )


def load_config(config_path: str, db_connector: DatabaseConnector) -> RuleConfig:
    """Load configuration from database with file fallback"""
    config = RuleConfig.from_database(
        db_connector,
        fallback_to_file=True,
        config_path=config_path
    )
    if os.path.exists(config_path):
        return config
    print(f"Config file {config_path} not found, creating default configuration")
    config.to_file(config_path)
    return config


def main():
    """Main function"""
    parser = argparse.ArgumentParser(description='Amazon Ads AI Rule Engine')
    parser.add_argument('--config', '-c', default='config/ai_rule_engine.json',
                       help='Configuration file path')
    parser.add_argument('--campaigns', '-p', nargs='+', type=int,
                       help='Specific campaign IDs to analyze (default: all)')
    parser.add_argument('--output', '-o', default='reports/ai_recommendations.json',
                       help='Output file path')
    parser.add_argument('--format', '-f', choices=['json', 'csv'], default='json',
                       help='Output format')
    parser.add_argument('--log-level', '-l', choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'],
                       default='INFO', help='Logging level')
    parser.add_argument('--max-recommendations', '-m', type=int, default=100,
                       help='Maximum number of recommendations to generate')
    parser.add_argument('--min-confidence', type=float, default=0.3,
                       help='Minimum confidence threshold for recommendations')
    parser.add_argument('--dry-run', action='store_true',
                       help='Run analysis without making changes')
    parser.add_argument('--sync', action='store_true',
                       help='Enable Amazon API sync (download data before, upload recommendations after)')
    parser.add_argument('--skip-download', action='store_true',
                       help='Skip downloading latest data from Amazon (use with --sync)')
    parser.add_argument('--skip-upload', action='store_true',
                       help='Skip uploading recommendations to Amazon (use with --sync)')
    parser.add_argument('--continuous', action='store_true',
                       help='Run continuously with periodic analysis (default: run once)')
    parser.add_argument('--interval', type=int, default=3600,
                       help='Interval in seconds between continuous runs (default: 3600 = 1 hour)')
    
    args = parser.parse_args()
    
    # Setup logging
    setup_logging(args.log_level)
    logger = logging.getLogger(__name__)
    
    try:
        # Setup database connection
        try:
            db_connector = DatabaseConnector()
        except ValueError as e:
            logger.error(f"Database configuration error: {e}")
            logger.error("Please ensure DB_HOST, DB_PORT, DB_NAME, DB_USER, and DB_PASSWORD are set")
            return 1
        logger.info("Database connector initialized")

        # Load configuration
        config = load_config(args.config, db_connector)
        config.validate()
        logger.info("Configuration loaded and validated")
        
        if args.continuous:
            # Continuous execution mode
            logger.info(f"Starting continuous execution mode (interval: {args.interval} seconds)")
            print(f"\n{'='*60}")
            print("AI RULE ENGINE - CONTINUOUS MODE")
            print(f"{'='*60}")
            print(f"Analysis interval: {args.interval} seconds ({args.interval/60:.1f} minutes)")
            print("Press Ctrl+C to stop")
            print(f"{'='*60}\n")
            
            run_count = 0
            try:
                while True:
                    run_count += 1
                    run_id = f"run{run_count}"
                    cycle_start = datetime.now()
                    
                    logger.info(f"Starting analysis cycle #{run_count} at {cycle_start.strftime('%Y-%m-%d %H:%M:%S')}")
                    
                    try:
                        filtered_recommendations = run_analysis_cycle(config, db_connector, args, run_id)
                        
                        # Print summary for this cycle
                        if filtered_recommendations:
                            summary = {}
                            for rec in filtered_recommendations:
                                summary.setdefault(rec.adjustment_type, 0)
                                summary[rec.adjustment_type] += 1
                            
                            print(f"\n[{cycle_start.strftime('%H:%M:%S')}] Cycle #{run_count} completed: {len(filtered_recommendations)} recommendations")
                            print(f"  Types: {summary}")
                            if filtered_recommendations:
                                top_rec = filtered_recommendations[0]
                                print(f"  Top: {top_rec.entity_type} {top_rec.entity_id} - {top_rec.adjustment_type} ${top_rec.current_value:.2f} → ${top_rec.recommended_value:.2f}")
                        
                        cycle_duration = (datetime.now() - cycle_start).total_seconds()
                        logger.info(f"Analysis cycle #{run_count} completed in {cycle_duration:.1f} seconds")
                        
                        # Export recommendations in continuous mode too (for this cycle)
                        if not args.dry_run and filtered_recommendations:
                            try:
                                engine = AIRuleEngine(config, db_connector)
                                cycle_output = args.output.replace('.json', f'_{run_count}.json').replace('.csv', f'_{run_count}.csv')
                                os.makedirs(os.path.dirname(cycle_output), exist_ok=True)
                                engine.export_recommendations(filtered_recommendations, cycle_output, args.format)
                                logger.debug(f"Cycle #{run_count} recommendations exported to {cycle_output}")
                            except Exception as export_err:
                                logger.warning(f"Error exporting recommendations for cycle #{run_count}: {export_err}")
                        
                    except Exception as e:
                        logger.error(f"Error in analysis cycle #{run_count}: {e}", exc_info=True)
                    
                    # Wait for next interval (always wait, even if cycle took longer than interval)
                    cycle_duration_total = (datetime.now() - cycle_start).total_seconds()
                    sleep_time = max(0, args.interval - cycle_duration_total)
                    if sleep_time > 0:
                        logger.info(f"Waiting {sleep_time:.1f} seconds until next analysis cycle...")
                        time.sleep(sleep_time)
                    else:
                        logger.info(f"Cycle took {cycle_duration_total:.1f} seconds (longer than interval {args.interval}s), starting next cycle immediately")
                        
            except KeyboardInterrupt:
                logger.info("Continuous execution stopped by user")
                print("\n\nContinuous execution stopped.")
                return 0
        else:
            # Single execution mode (original behavior)
            filtered_recommendations = run_analysis_cycle(config, db_connector, args, "run1")
            
            # Generate summary
            engine = AIRuleEngine(config, db_connector)
            summary = engine.get_recommendations_summary(filtered_recommendations)
            
            # Print summary
            print("\n" + "="*60)
            print("AI RULE ENGINE ANALYSIS RESULTS")
            print("="*60)
            print(f"Analysis completed at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            print(f"Total recommendations generated: {summary['total_recommendations']}")
            print(f"Recommendations by type: {summary['by_type']}")
            print(f"Recommendations by priority: {summary['by_priority']}")
            print(f"Recommendations by entity type: {summary['by_entity_type']}")
            print(f"Total adjustment value: ${summary['total_adjustment_value']:.2f}")
            print("="*60)
            
            # Show top recommendations
            if filtered_recommendations:
                print("\nTOP RECOMMENDATIONS:")
                print("-" * 60)
                for i, rec in enumerate(filtered_recommendations[:10], 1):
                    print(f"{i:2d}. {rec.entity_type.upper()} {rec.entity_id} - {rec.entity_name}")
                    print(f"     {rec.adjustment_type.upper()}: ${rec.current_value:.2f} → ${rec.recommended_value:.2f}")
                    print(f"     Priority: {rec.priority.upper()} | Confidence: {rec.confidence:.1%}")
                    print(f"     Reason: {rec.reason}")
                    print()
            
            logger.info("Analysis completed successfully")
            return 0
        
    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        return 1


def run_analysis_cycle(config: RuleConfig, db_connector, args, run_id: str = "run1"):
    """Run a single analysis cycle"""
    try:
        # Initialize AI Rule Engine
        engine = AIRuleEngine(config, db_connector)
        logger = logging.getLogger(__name__)
        logger.info("AI Rule Engine initialized")
        
        sync_manager = None
        if args.sync and not args.dry_run:
            try:
                from ai_rule_engine.amazon_sync import AmazonSyncManager
                sync_manager = AmazonSyncManager(config.__dict__, db_connector)
                logger.info("Amazon Sync Manager initialized")
            except Exception as e:
                logger.warning(f"Could not initialize Amazon Sync Manager: {e}")
        
        # Step 1: Download latest data BEFORE analysis (if sync enabled)
        if sync_manager and not args.skip_download:
            logger.info("Downloading latest Amazon performance data...")
            download_result = sync_manager.download_yesterday_performance()
            if download_result.success:
                logger.info(f"Download successful: {download_result.records_processed} records")
        
        # Step 2: Run analysis
        logger.info("Starting analysis...")
        recommendations = engine.analyze_campaigns(args.campaigns)
        
        # Filter recommendations
        filtered_recommendations = engine.recommendation_engine.filter_recommendations(
            recommendations,
            max_recommendations=args.max_recommendations,
            min_confidence=args.min_confidence
        )
        
        # Generate summary
        summary = engine.get_recommendations_summary(filtered_recommendations)
        logger.info(f"Generated {summary['total_recommendations']} recommendations")
        
        # Step 3: Run learning loop evaluation and training if enabled
        if engine.learning_loop and engine.model_trainer:
            logger.info("Running learning loop evaluation...")
            try:
                from ai_rule_engine.evaluation_pipeline import EvaluationPipeline
                evaluation_pipeline = EvaluationPipeline(
                    config.__dict__, db_connector, engine.learning_loop, engine.model_trainer
                )
                eval_results = evaluation_pipeline.run_daily_evaluation()
                logger.info(f"Learning loop evaluation completed: {eval_results.get('total_outcomes', 0)} outcomes")
            except Exception as e:
                logger.warning(f"Learning loop evaluation failed: {e}")
        
        # Export recommendations
        if not args.dry_run:
            os.makedirs(os.path.dirname(args.output), exist_ok=True)
            engine.export_recommendations(filtered_recommendations, args.output, args.format)
            
            if sync_manager and not args.skip_upload:
                logger.info("Uploading approved recommendations to Amazon...")
                upload_result = sync_manager.upload_approved_recommendations()
                if upload_result.success:
                    logger.info(f"Upload successful: {upload_result.records_processed} recommendations applied")

        # Sync recommendation_tracking.current_value from entity tables (keywords.bid, ad_groups.default_bid, etc.)
        # so UI shows actual current values. Called here so it always runs with current engine code.
        try:
            from .database import run_sync_recommendation_tracking_from_entities
            n = run_sync_recommendation_tracking_from_entities(db_connector)
            if n:
                logger.info(f"Synced {n} recommendation_tracking rows from entity tables")
        except Exception as sync_err:
            logger.warning("Recommendation tracking sync from entities failed: %s", sync_err)
        
        return filtered_recommendations
        
    except Exception as e:
        logger = logging.getLogger(__name__)
        logger.error(f"Analysis cycle failed: {e}", exc_info=True)
        raise


if __name__ == '__main__':
    exit_code = main()
    sys.exit(exit_code)
