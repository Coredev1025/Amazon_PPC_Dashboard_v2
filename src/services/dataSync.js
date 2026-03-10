const AmazonAdsClient = require('../api/amazonAdsClient');
const db = require('../database/connection');
const logger = require('../utils/logger');

class DataSyncService {
  constructor(config = {}) {
    this.config = {
      // Performance optimization settings
      maxRetries: config.maxRetries || 3,
      batchSize: config.batchSize || 50,
      rateLimitDelay: config.rateLimitDelay || 100
    };
    
    this.client = new AmazonAdsClient();
  }

  async syncPortfolios() {
    try {
      logger.info('📋 Syncing portfolios from Amazon Ads API v3...');
      const portfolios = await this.client.getPortfolios();

      if (!portfolios || portfolios.length === 0) {
        logger.warn('⚠️  No portfolios returned from API');
        return 0;
      }

      logger.info(`📥 Retrieved ${portfolios.length} portfolios, saving to database...`);

      let synced = 0;
      let errors = 0;
      
      for (const portfolio of portfolios) {
        try {
          if (!portfolio.portfolioId) {
            logger.warn('Skipping portfolio without portfolioId:', portfolio);
            errors++;
            continue;
          }
          
          const portfolioId = String(portfolio.portfolioId);
          const portfolioName = portfolio.name || 'Unnamed Portfolio';
          const state = (portfolio.state || 'ENABLED').toUpperCase();
          const budgetAmount = portfolio.budget?.budget || portfolio.budgetAmount || null;
          const budgetType = portfolio.budget?.budgetType || portfolio.budgetType || 'DAILY';

          await db.query(
            `INSERT INTO portfolios (
              portfolio_id, portfolio_name, budget_amount, 
              budget_type, state
            ) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (portfolio_id) 
            DO UPDATE SET
              portfolio_name = $2,
              budget_amount = $3,
              budget_type = $4,
              state = $5,
              updated_at = CURRENT_TIMESTAMP`,
            [portfolioId, portfolioName, budgetAmount, budgetType, state]
          );
          synced++;
        } catch (error) {
          logger.error(`Error syncing portfolio ${portfolio.portfolioId}:`, error.message);
          errors++;
        }
      }

      logger.info(`✅ Synced ${synced} portfolios${errors > 0 ? `, ${errors} errors` : ''}`);
      return synced;
    } catch (error) {
      logger.error('❌ Error syncing portfolios:', error.message);
      throw error;
    }
  }

  /**
   * Sync campaigns data using v3 API
   * v3 API field names are different from v2:
   * - state -> state (ENABLED, PAUSED, ARCHIVED) - stored as-is in uppercase
   * - name -> name
   * - budget -> budget.budget or dailyBudget
   * Now supports SP, SB, and SD campaign types
   */
  async syncCampaigns() {
    try {
      logger.info('📋 Syncing campaigns from Amazon Ads API v3...');
      const campaigns = await this.client.getCampaigns();

      if (!campaigns || campaigns.length === 0) {
        logger.warn('⚠️  No campaigns returned from API');
        return 0;
      }

      logger.info(`📥 Retrieved ${campaigns.length} campaigns, saving to database...`);

      let synced = 0;
      let errors = 0;
      
      for (const campaign of campaigns) {
        try {
        // v3 API response structure
        // {
        //   campaignId, name, state, targetingType, startDate, endDate,
        //   budget: { budgetType, budget }, dynamicBidding, ...
        // }
          
          // Validate required fields
          if (!campaign.campaignId) {
            logger.warn('Skipping campaign without campaignId:', campaign);
            errors++;
            continue;
          }
          
          const campaignId = String(campaign.campaignId); // Ensure string for BIGINT
          const campaignName = campaign.name || 'Unnamed Campaign';
          const campaignState = (campaign.state || 'ENABLED').toUpperCase(); // ENABLED, PAUSED, ARCHIVED - store in uppercase
          const targetingType = campaign.targetingType || 'MANUAL';
        const startDate = campaign.startDate || null;
        const endDate = campaign.endDate || null;
          
          // Handle budget - v3 API can return budget in different formats
          let budgetAmount = null;
          let budgetType = 'DAILY';
          
          if (campaign.budget) {
            budgetAmount = campaign.budget.budget || campaign.budget.budgetAmount || null;
            budgetType = campaign.budget.budgetType || campaign.budget.type || 'DAILY';
          } else if (campaign.dailyBudget) {
            budgetAmount = campaign.dailyBudget;
            budgetType = 'DAILY';
          }

          // v2.0: Extract portfolio_id, campaign_type, and ad type
          const portfolioId = campaign.portfolioId ? String(campaign.portfolioId) : null;
          const campaignType = campaign.campaignType || 'SP'; // SP, SB, SD
          const sbAdType = campaign.adFormat || campaign.sbAdType || null; // PRODUCT_COLLECTION, STORE_SPOTLIGHT, VIDEO
          const sdTargetingType = campaign.targetingType === 'AUDIENCES' ? 'AUDIENCES' : 
                                   campaign.targetingType === 'CONTEXTUAL' ? 'CONTEXTUAL' : null;

        await db.query(
          `INSERT INTO campaigns (
            campaign_id, campaign_name, campaign_status, 
            targeting_type, start_date, end_date,
            budget_amount, budget_type, portfolio_id,
            campaign_type, sb_ad_type, sd_targeting_type
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (campaign_id) 
          DO UPDATE SET
            campaign_name = $2,
            campaign_status = $3,
            targeting_type = $4,
            start_date = $5,
            end_date = $6,
            budget_amount = $7,
            budget_type = $8,
            portfolio_id = $9,
            campaign_type = $10,
            sb_ad_type = $11,
            sd_targeting_type = $12,
            updated_at = CURRENT_TIMESTAMP`,
          [
            campaignId,
            campaignName,
            campaignState,
            targetingType,
            startDate,
            endDate,
            budgetAmount,
            budgetType,
            portfolioId,
            campaignType,
            sbAdType,
            sdTargetingType
          ]
        );
        synced++;
        
        // Log progress every 50 campaigns
        if (synced % 50 === 0) {
          logger.info(`📋 Campaigns progress: ${synced}/${campaigns.length}`);
          }
        } catch (error) {
          logger.error(`Error syncing campaign ${campaign.campaignId}:`, error.message);
          errors++;
        }
      }

      logger.info(`✅ Synced ${synced} campaigns${errors > 0 ? `, ${errors} errors` : ''}`);
      return synced;
    } catch (error) {
      logger.error('❌ Error syncing campaigns:', error.message);
      throw error;
    }
  }

  /**
   * Sync ad groups data using v3 API
   * v3 API response structure:
   * { adGroupId, name, campaignId, defaultBid, state }
   */
  async syncAdGroups() {
    try {
      logger.info('📋 Syncing ad groups from Amazon Ads API v3...');
      const adGroups = await this.client.getAdGroups();

      if (!adGroups || adGroups.length === 0) {
        logger.warn('⚠️  No ad groups returned from API');
        return 0;
      }

      logger.info(`📥 Retrieved ${adGroups.length} ad groups, saving to database...`);

      let synced = 0;
      let skipped = 0;
      let errors = 0;
      
      // Build set of existing campaign IDs for faster lookup
      const campaignResult = await db.query('SELECT campaign_id FROM campaigns');
      const existingCampaignIds = new Set(campaignResult.rows.map(r => String(r.campaign_id)));
      
      for (const adGroup of adGroups) {
        try {
          // Validate required fields
          if (!adGroup.adGroupId) {
            logger.warn('Skipping ad group without adGroupId:', adGroup);
            errors++;
            continue;
          }
          
          if (!adGroup.campaignId) {
            logger.warn(`Skipping ad group ${adGroup.adGroupId} without campaignId`);
            errors++;
            continue;
          }
          
          // Check if campaign exists
          const campaignIdStr = String(adGroup.campaignId);
          if (!existingCampaignIds.has(campaignIdStr)) {
          logger.debug(`Skipping ad group ${adGroup.adGroupId} - campaign ${adGroup.campaignId} not found`);
          skipped++;
          continue;
        }

          // v3 API response fields - ensure proper data types and defaults
          const adGroupId = String(adGroup.adGroupId); // BIGINT as string
          const adGroupName = adGroup.name || 'Unnamed Ad Group';
          const campaignId = campaignIdStr;
        const defaultBid = adGroup.defaultBid || adGroup.bid || null;
          const state = (adGroup.state || 'ENABLED').toUpperCase(); // ENABLED, PAUSED, ARCHIVED - store in uppercase
        
        await db.query(
          `INSERT INTO ad_groups (
            ad_group_id, ad_group_name, campaign_id,
            default_bid, state
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (ad_group_id)
          DO UPDATE SET
            ad_group_name = $2,
            campaign_id = $3,
            default_bid = $4,
            state = $5,
            updated_at = CURRENT_TIMESTAMP`,
          [
            adGroupId,
            adGroupName,
            campaignId,
            defaultBid,
            state
          ]
        );
        synced++;
        
        // Log progress every 100 ad groups
        if (synced % 100 === 0) {
          logger.info(`📋 Ad groups progress: ${synced}/${adGroups.length}`);
          }
        } catch (error) {
          logger.error(`Error syncing ad group ${adGroup.adGroupId}:`, error.message);
          errors++;
        }
      }

      logger.info(`✅ Synced ${synced} ad groups, skipped ${skipped} (missing campaigns)${errors > 0 ? `, ${errors} errors` : ''}`);
      return synced;
    } catch (error) {
      logger.error('❌ Error syncing ad groups:', error.message);
      throw error;
    }
  }

  /**
   * Normalize an ad group from SB or SD API to common shape: { adGroupId, campaignId, name, defaultBid, state }
   */
  _normalizeAdGroup(adGroup, source) {
    const id = adGroup.adGroupId ?? adGroup.ad_group_id ?? adGroup.id;
    const campaignId = adGroup.campaignId ?? adGroup.campaign_id;
    const name = adGroup.name ?? adGroup.adGroupName ?? adGroup.ad_group_name ?? 'Unnamed Ad Group';
    const defaultBid = adGroup.defaultBid ?? adGroup.bid ?? adGroup.default_bid ?? null;
    const state = (adGroup.state ?? adGroup.adGroupState ?? 'ENABLED').toUpperCase();
    return { adGroupId: id, campaignId, name, defaultBid, state };
  }

  /**
   * Persist a list of normalized ad groups into ad_groups table (same schema as SP).
   * Used by SP, SB, and SD sync. existingCampaignIds must be a Set of string campaign IDs.
   */
  async _upsertAdGroups(adGroups, existingCampaignIds, options = {}) {
    const { sourceLabel = 'ad groups', logEvery = 100 } = options;
    let synced = 0;
    let skipped = 0;
    let errors = 0;

    for (const raw of adGroups) {
      try {
        const adGroup = this._normalizeAdGroup(raw, sourceLabel);
        if (!adGroup.adGroupId) {
          logger.warn(`Skipping ${sourceLabel} item without adGroupId:`, raw);
          errors++;
          continue;
        }
        if (!adGroup.campaignId) {
          logger.warn(`Skipping ad group ${adGroup.adGroupId} without campaignId`);
          errors++;
          continue;
        }
        const campaignIdStr = String(adGroup.campaignId);
        if (!existingCampaignIds.has(campaignIdStr)) {
          skipped++;
          continue;
        }
        const adGroupId = String(adGroup.adGroupId);
        const adGroupName = adGroup.name || 'Unnamed Ad Group';
        const defaultBid = adGroup.defaultBid ?? null;
        const state = adGroup.state || 'ENABLED';

        await db.query(
          `INSERT INTO ad_groups (
            ad_group_id, ad_group_name, campaign_id,
            default_bid, state
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (ad_group_id)
          DO UPDATE SET
            ad_group_name = $2,
            campaign_id = $3,
            default_bid = $4,
            state = $5,
            updated_at = CURRENT_TIMESTAMP`,
          [adGroupId, adGroupName, campaignIdStr, defaultBid, state]
        );
        synced++;
        if (synced % logEvery === 0) {
          logger.info(`📋 ${sourceLabel} progress: ${synced} synced`);
        }
      } catch (error) {
        logger.error(`Error syncing ${sourceLabel} item:`, error.message);
        errors++;
      }
    }
    return { synced, skipped, errors };
  }

  /**
   * Sync Sponsored Brands ad groups from Amazon Ads API v4.
   * SB campaigns must be synced first (syncSponsoredBrandsCampaigns) so campaign_id exists.
   */
  async syncSponsoredBrandsAdGroups() {
    try {
      logger.info('📋 Syncing Sponsored Brands ad groups from Amazon Ads API v4...');
      const campaignResult = await db.query('SELECT campaign_id FROM campaigns WHERE campaign_type = $1', ['SB']);
      const existingCampaignIds = new Set(campaignResult.rows.map(r => String(r.campaign_id)));
      if (existingCampaignIds.size === 0) {
        logger.info('No SB campaigns in database, skipping SB ad groups sync');
        return 0;
      }

      const adGroups = await this.client.getAllSponsoredBrandsAdGroups();
      if (!adGroups || adGroups.length === 0) {
        logger.info('⚠️  No Sponsored Brands ad groups returned from API');
        return 0;
      }
      logger.info(`📥 Retrieved ${adGroups.length} Sponsored Brands ad groups, saving to database...`);
      const { synced, skipped, errors } = await this._upsertAdGroups(adGroups, existingCampaignIds, { sourceLabel: 'SB ad groups' });
      logger.info(`✅ Synced ${synced} Sponsored Brands ad groups, skipped ${skipped} (missing campaigns)${errors > 0 ? `, ${errors} errors` : ''}`);
      return synced;
    } catch (error) {
      logger.error('❌ Error syncing Sponsored Brands ad groups:', error.message);
      throw error;
    }
  }

  /**
   * Sync Sponsored Display ad groups from Amazon Ads API v3.
   * SD campaigns must be synced first (syncSponsoredDisplayCampaigns) so campaign_id exists.
   */
  async syncSponsoredDisplayAdGroups() {
    try {
      logger.info('📋 Syncing Sponsored Display ad groups from Amazon Ads API v3...');
      const campaignResult = await db.query('SELECT campaign_id FROM campaigns WHERE campaign_type = $1', ['SD']);
      const existingCampaignIds = new Set(campaignResult.rows.map(r => String(r.campaign_id)));
      if (existingCampaignIds.size === 0) {
        logger.info('No SD campaigns in database, skipping SD ad groups sync');
        return 0;
      }

      const adGroups = await this.client.getAllSponsoredDisplayAdGroups();
      if (!adGroups || adGroups.length === 0) {
        logger.info('⚠️  No Sponsored Display ad groups returned from API');
        return 0;
      }
      logger.info(`📥 Retrieved ${adGroups.length} Sponsored Display ad groups, saving to database...`);
      const { synced, skipped, errors } = await this._upsertAdGroups(adGroups, existingCampaignIds, { sourceLabel: 'SD ad groups' });
      logger.info(`✅ Synced ${synced} Sponsored Display ad groups, skipped ${skipped} (missing campaigns)${errors > 0 ? `, ${errors} errors` : ''}`);
      return synced;
    } catch (error) {
      logger.error('❌ Error syncing Sponsored Display ad groups:', error.message);
      throw error;
    }
  }

  /**
   * Sync keywords data using v3 API
   * v3 API response structure:
   * { keywordId, keywordText, matchType, campaignId, adGroupId, bid, state }
   */
  async syncKeywords() {
    try {
      logger.info('📋 Syncing keywords from Amazon Ads API v3...');
      const keywords = await this.client.getKeywords();

      if (!keywords || keywords.length === 0) {
        logger.warn('⚠️  No keywords returned from API');
        return 0;
      }

      logger.info(`📥 Retrieved ${keywords.length} keywords, saving to database...`);

      let synced = 0;
      let skipped = 0;
      let errors = 0;
      
      // Build a set of existing campaign and ad group IDs for faster lookup
      const campaignResult = await db.query('SELECT campaign_id FROM campaigns');
      const adGroupResult = await db.query('SELECT ad_group_id FROM ad_groups');
      const campaignIds = new Set(campaignResult.rows.map(r => String(r.campaign_id)));
      const adGroupIds = new Set(adGroupResult.rows.map(r => String(r.ad_group_id)));
      
      for (const keyword of keywords) {
        try {
          // Validate required fields
          if (!keyword.keywordId) {
            logger.warn('Skipping keyword without keywordId:', keyword);
            errors++;
            continue;
          }
          
          if (!keyword.campaignId || !keyword.adGroupId) {
            logger.warn(`Skipping keyword ${keyword.keywordId} without campaignId or adGroupId`);
            errors++;
            continue;
          }
          
        // Check if campaign and ad group exist
          const campaignIdStr = String(keyword.campaignId);
          const adGroupIdStr = String(keyword.adGroupId);
          
          if (!campaignIds.has(campaignIdStr)) {
          logger.debug(`Skipping keyword ${keyword.keywordId} - campaign ${keyword.campaignId} not found`);
          skipped++;
          continue;
        }
        
          if (!adGroupIds.has(adGroupIdStr)) {
          logger.debug(`Skipping keyword ${keyword.keywordId} - ad group ${keyword.adGroupId} not found`);
          skipped++;
          continue;
        }

          // v3 API response fields - ensure proper data types and defaults
          const keywordId = String(keyword.keywordId); // BIGINT as string
          const keywordText = keyword.keywordText || keyword.keyword || '';
          const matchType = (keyword.matchType || 'BROAD').toUpperCase(); // BROAD, PHRASE, EXACT
          const campaignId = campaignIdStr;
          const adGroupId = adGroupIdStr;
        const bid = keyword.bid || null;
          const state = (keyword.state || 'ENABLED').toUpperCase(); // ENABLED, PAUSED, ARCHIVED - store in uppercase
        
        await db.query(
          `INSERT INTO keywords (
            keyword_id, keyword_text, match_type,
            campaign_id, ad_group_id, bid, state
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (keyword_id)
          DO UPDATE SET
            keyword_text = $2,
            match_type = $3,
            campaign_id = $4,
            ad_group_id = $5,
            bid = $6,
            state = $7,
            updated_at = CURRENT_TIMESTAMP`,
          [
            keywordId,
            keywordText,
            matchType,
            campaignId,
            adGroupId,
            bid,
            state
          ]
        );
        synced++;
        
        // Log progress every 200 keywords
        if (synced % 200 === 0) {
          logger.info(`📋 Keywords progress: ${synced}/${keywords.length}`);
          }
        } catch (error) {
          logger.error(`Error syncing keyword ${keyword.keywordId}:`, error.message);
          errors++;
        }
      }

      logger.info(`✅ Synced ${synced} keywords, skipped ${skipped} (missing campaigns/ad groups)${errors > 0 ? `, ${errors} errors` : ''}`);
      return synced;
    } catch (error) {
      logger.error('❌ Error syncing keywords:', error.message);
      throw error;
    }
  }

  /**
   * Convert API date format (YYYYMMDD) to database format (YYYY-MM-DD)
   */
  formatDateForDB(apiDate) {
    if (apiDate.includes('-')) return apiDate; // Already formatted
    // Convert 20241020 to 2024-10-20
    return `${apiDate.substr(0, 4)}-${apiDate.substr(4, 2)}-${apiDate.substr(6, 2)}`;
  }

  /**
   * Sync performance data for campaigns
   */
  async syncCampaignPerformance(reportDate) {
    try {
      logger.info(`📊 [CAMPAIGNS] Syncing campaign performance for ${reportDate}...`);
      logger.info(`📊 [CAMPAIGNS] Requesting report from Amazon Ads API...`);
      
      const reportData = await this.client.getPerformanceData('campaigns', reportDate, reportDate);

      if (!reportData || reportData.length === 0) {
        logger.warn(`⚠️  [CAMPAIGNS] No campaign performance data returned for ${reportDate}`);
        return 0;
      }

      // Validate report data structure
      if (!Array.isArray(reportData)) {
        logger.error(`❌ [CAMPAIGNS] Invalid report data format for ${reportDate}`);
        return 0;
      }

      logger.info(`📊 [CAMPAIGNS] Received ${reportData.length} records, saving to database...`);
      
      const dbDate = this.formatDateForDB(reportDate);
      let synced = 0;
      const total = reportData.length;

      for (const record of reportData) {
        if (!record.campaignId) continue;

        // Check if campaign exists before inserting performance data
        const campaignCheck = await db.query(
          'SELECT campaign_id FROM campaigns WHERE campaign_id = $1',
          [record.campaignId]
        );
        
        if (campaignCheck.rows.length === 0) {
          logger.warn(`Skipping campaign performance for ${record.campaignId} - campaign not found in campaigns table`);
          continue;
        }

        // Add rate limiting - small delay between database operations
        if (synced > 0 && synced % this.config.batchSize === 0) {
          await new Promise(resolve => setTimeout(resolve, this.config.rateLimitDelay));
        }

        const impressions = parseInt(this.parsePerformanceNumber(record.impressions), 10) || 0;
        const clicks = parseInt(this.parsePerformanceNumber(record.clicks), 10) || 0;
        const cost = this.parsePerformanceNumber(record.cost);
        const purchases1d = parseInt(this.parsePerformanceNumber(record.purchases1d), 10) || 0;
        const purchases7d = parseInt(this.parsePerformanceNumber(record.purchases7d), 10) || 0;
        const purchases14d = parseInt(this.parsePerformanceNumber(record.purchases14d), 10) || 0;
        const purchases30d = parseInt(this.parsePerformanceNumber(record.purchases30d), 10) || 0;
        const sales1d = this.parsePerformanceNumber(record.sales1d);
        const sales7d = this.parsePerformanceNumber(record.sales7d);
        const sales14d = this.parsePerformanceNumber(record.sales14d);
        const sales30d = this.parsePerformanceNumber(record.sales30d);

        await db.query(
          `INSERT INTO campaign_performance (
            campaign_id, report_date, impressions, clicks, cost,
            attributed_conversions_1d, attributed_conversions_7d,
            attributed_conversions_14d, attributed_conversions_30d,
            attributed_sales_1d, attributed_sales_7d,
            attributed_sales_14d, attributed_sales_30d
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (campaign_id, report_date)
          DO UPDATE SET
            impressions = $3,
            clicks = $4,
            cost = $5,
            attributed_conversions_1d = $6,
            attributed_conversions_7d = $7,
            attributed_conversions_14d = $8,
            attributed_conversions_30d = $9,
            attributed_sales_1d = $10,
            attributed_sales_7d = $11,
            attributed_sales_14d = $12,
            attributed_sales_30d = $13,
            updated_at = CURRENT_TIMESTAMP`,
          [
            record.campaignId,
            dbDate,
            impressions,
            clicks,
            cost,
            purchases1d,
            purchases7d,
            purchases14d,
            purchases30d,
            sales1d,
            sales7d,
            sales14d,
            sales30d
          ]
        );
        synced++;

        // Log progress every 10 records or at the end
        if (synced % 10 === 0 || synced === total) {
          logger.info(`📊 [CAMPAIGNS] Progress: ${synced}/${total} records saved (${Math.round(synced/total*100)}%)`);
        }
      }

      logger.info(`✅ [CAMPAIGNS] Successfully synced ${synced} campaign performance records for ${reportDate}`);
      return synced;
    } catch (error) {
      logger.error(`❌ [CAMPAIGNS] Error syncing campaign performance:`, error.message);
      throw error;
    }
  }

  /**
   * Parse numeric value for performance fields (avoids "b.00" / string corruption in DB)
   */
  parsePerformanceNumber(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number' && !Number.isNaN(value)) return value;
    const n = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isNaN(n) ? 0 : n;
  }

  /**
   * Normalize SB (or any v3) report response so we always get an array of row objects.
   * Handles: raw array of objects, wrapped { data/records/results }, or array-of-arrays (header row + data rows).
   */
  normalizeReportRows(raw) {
    if (raw == null) return [];
    let rows = raw;
    if (!Array.isArray(raw) && typeof raw === 'object') {
      rows = raw.data ?? raw.records ?? raw.results ?? raw.body ?? raw.rows ?? [];
    }
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const first = rows[0];
    if (Array.isArray(first) && first.length > 0 && typeof first[0] === 'string') {
      const headers = first.map(h => (h && typeof h === 'string' ? h : String(h)));
      return rows.slice(1).map(row => {
        const obj = {};
        headers.forEach((key, i) => { obj[key] = row[i]; });
        return obj;
      });
    }
    return rows;
  }

  /**
   * Sync Sponsored Brands (SB) campaign performance into campaign_performance.
   *
   * SB uses DIFFERENT column names from SP in the v3 Reporting API:
   *   SP: purchases1d, purchases7d, purchases14d, purchases30d, sales1d, sales7d, sales14d, sales30d
   *   SB: purchases, purchasesClicks, sales, salesClicks  (14-day attribution, NO time suffix)
   *
   * We map SB fields → campaign_performance table as follows:
   *   impressions        → impressions
   *   clicks             → clicks
   *   cost               → cost
   *   purchasesClicks    → attributed_conversions_7d AND attributed_conversions_14d
   *   salesClicks        → attributed_sales_7d AND attributed_sales_14d
   *   (1d and 30d set to 0 — SB only supports 14-day attribution)
   *
   * The dashboard queries attributed_conversions_7d / attributed_sales_7d for totals,
   * so we store the SB value there to keep the dashboard working uniformly.
   *
   * Reference: https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/report-types/campaign
   */
  async syncSBCampaignPerformance(reportDate) {
    try {
      logger.info(`📊 [SB CAMPAIGNS] Syncing Sponsored Brands campaign performance for ${reportDate}...`);

      const dbDate = this.formatDateForDB(reportDate);

      const sbCampaignsResult = await db.query(
        'SELECT campaign_id FROM campaigns WHERE campaign_type = $1',
        ['SB']
      );
      const allSBCampaignIds = (sbCampaignsResult.rows || []).map(r => String(r.campaign_id));
      if (allSBCampaignIds.length === 0) {
        logger.info(`📊 [SB CAMPAIGNS] No SB campaigns in campaigns table for ${reportDate}`);
        return 0;
      }
      logger.info(`📊 [SB CAMPAIGNS] Found ${allSBCampaignIds.length} SB campaigns in DB`);

      let reportData = [];
      try {
        const raw = await this.client.getSBCampaignPerformanceData(reportDate);
        reportData = this.normalizeReportRows(raw);
        logger.info(`📊 [SB CAMPAIGNS] API returned ${reportData.length} records for ${reportDate}`);
      } catch (apiError) {
        logger.warn(`⚠️  [SB CAMPAIGNS] SB campaign performance API error for ${reportDate}: ${apiError.message}`);
      }

      const apiByCampaignId = new Map();
      for (const record of reportData) {
        const campaignId = (record.campaignId ?? record.campaign_id) != null
          ? String(record.campaignId ?? record.campaign_id)
          : null;
        if (campaignId && allSBCampaignIds.includes(campaignId)) {
          apiByCampaignId.set(campaignId, record);
        }
      }
      logger.info(`📊 [SB CAMPAIGNS] Matched ${apiByCampaignId.size} API records to SB campaigns`);

      let synced = 0;
      const total = allSBCampaignIds.length;

      const get = (r, ...keys) => {
        if (r == null) return undefined;
        for (const k of keys) {
          const v = r[k];
          if (v !== undefined && v !== null && v !== '') return v;
        }
        return undefined;
      };

      for (const campaignId of allSBCampaignIds) {
        if (synced > 0 && synced % this.config.batchSize === 0) {
          await new Promise(resolve => setTimeout(resolve, this.config.rateLimitDelay));
        }

        const r = apiByCampaignId.get(campaignId);
        const impressions = r != null ? parseInt(this.parsePerformanceNumber(get(r, 'impressions')), 10) || 0 : 0;
        const clicks      = r != null ? parseInt(this.parsePerformanceNumber(get(r, 'clicks')), 10) || 0 : 0;
        const cost        = r != null ? this.parsePerformanceNumber(get(r, 'cost')) : 0;

        // SB fields: purchasesClicks / purchases (camelCase or snake_case from array-of-arrays)
        const conversions14d = r != null
          ? parseInt(this.parsePerformanceNumber(get(r, 'purchasesClicks', 'purchases_clicks', 'purchases')), 10) || 0
          : 0;

        // SB fields: salesClicks / sales
        const sales14d = r != null
          ? this.parsePerformanceNumber(get(r, 'salesClicks', 'sales_clicks', 'sales'))
          : 0;

        // SB only supports 14-day attribution. Populate 7d columns with the same value
        // because the dashboard queries attributed_conversions_7d / attributed_sales_7d.
        await db.query(
          `INSERT INTO campaign_performance (
            campaign_id, report_date, impressions, clicks, cost,
            attributed_conversions_1d, attributed_conversions_7d,
            attributed_conversions_14d, attributed_conversions_30d,
            attributed_sales_1d, attributed_sales_7d,
            attributed_sales_14d, attributed_sales_30d
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (campaign_id, report_date)
          DO UPDATE SET
            impressions = $3,
            clicks = $4,
            cost = $5,
            attributed_conversions_1d = $6,
            attributed_conversions_7d = $7,
            attributed_conversions_14d = $8,
            attributed_conversions_30d = $9,
            attributed_sales_1d = $10,
            attributed_sales_7d = $11,
            attributed_sales_14d = $12,
            attributed_sales_30d = $13,
            updated_at = CURRENT_TIMESTAMP`,
          [
            campaignId,
            dbDate,
            impressions,
            clicks,
            cost,
            0,                // attributed_conversions_1d  — not available for SB
            conversions14d,   // attributed_conversions_7d  — SB 14d value (dashboard reads this)
            conversions14d,   // attributed_conversions_14d — SB 14d value
            0,                // attributed_conversions_30d — not available for SB
            0,                // attributed_sales_1d        — not available for SB
            sales14d,         // attributed_sales_7d        — SB 14d value (dashboard reads this)
            sales14d,         // attributed_sales_14d       — SB 14d value
            0                 // attributed_sales_30d       — not available for SB
          ]
        );
        synced++;
        if (synced % 10 === 0 || synced === total) {
          logger.info(`📊 [SB CAMPAIGNS] Progress: ${synced}/${total} records (${Math.round(synced / total * 100)}%)`);
        }
      }

      logger.info(`✅ [SB CAMPAIGNS] Synced ${synced} SB campaign performance records for ${reportDate} (all campaign_type=SB)`);
      return synced;
    } catch (error) {
      logger.error(`❌ [SB CAMPAIGNS] Error syncing SB campaign performance:`, error.message);
      throw error;
    }
  }

  /**
   * Sync Sponsored Display (SD) campaign performance into campaign_performance.
   * Uses v3 Reporting API with adProduct SPONSORED_DISPLAY, reportTypeId sdCampaigns.
   * SD reports use purchasesClicks/salesClicks (not 1d/7d/14d/30d); we map to 7d/14d for dashboard compatibility.
   */
  async syncSDCampaignPerformance(reportDate) {
    try {
      logger.info(`📊 [SD CAMPAIGNS] Syncing Sponsored Display campaign performance for ${reportDate}...`);

      const dbDate = this.formatDateForDB(reportDate);

      const sdCampaignsResult = await db.query(
        'SELECT campaign_id FROM campaigns WHERE campaign_type = $1',
        ['SD']
      );
      const allSDCampaignIds = (sdCampaignsResult.rows || []).map(r => String(r.campaign_id));
      if (allSDCampaignIds.length === 0) {
        logger.info(`📊 [SD CAMPAIGNS] No SD campaigns in campaigns table for ${reportDate}`);
        return 0;
      }
      logger.info(`📊 [SD CAMPAIGNS] Found ${allSDCampaignIds.length} SD campaigns in DB`);

      let reportData = [];
      try {
        const raw = await this.client.getSDCampaignPerformanceData(reportDate);
        reportData = this.normalizeReportRows(raw);
        logger.info(`📊 [SD CAMPAIGNS] API returned ${reportData.length} records for ${reportDate}`);
      } catch (apiError) {
        logger.warn(`⚠️  [SD CAMPAIGNS] SD campaign performance API error for ${reportDate}: ${apiError.message}`);
      }

      const apiByCampaignId = new Map();
      for (const record of reportData) {
        const campaignId = (record.campaignId ?? record.campaign_id) != null
          ? String(record.campaignId ?? record.campaign_id)
          : null;
        if (campaignId && allSDCampaignIds.includes(campaignId)) {
          apiByCampaignId.set(campaignId, record);
        }
      }
      logger.info(`📊 [SD CAMPAIGNS] Matched ${apiByCampaignId.size} API records to SD campaigns`);

      const get = (r, ...keys) => {
        if (r == null) return undefined;
        for (const k of keys) {
          const v = r[k];
          if (v !== undefined && v !== null && v !== '') return v;
        }
        return undefined;
      };

      let synced = 0;
      const total = allSDCampaignIds.length;

      for (const campaignId of allSDCampaignIds) {
        if (synced > 0 && synced % this.config.batchSize === 0) {
          await new Promise(resolve => setTimeout(resolve, this.config.rateLimitDelay));
        }

        const r = apiByCampaignId.get(campaignId);
        const impressions = r != null ? parseInt(this.parsePerformanceNumber(get(r, 'impressions')), 10) || 0 : 0;
        const clicks = r != null ? parseInt(this.parsePerformanceNumber(get(r, 'clicks')), 10) || 0 : 0;
        const cost = r != null ? this.parsePerformanceNumber(get(r, 'cost', 'spend')) : 0;
        // SD API returns purchasesClicks / salesClicks (no 1d/7d/14d/30d); map to 7d/14d for dashboard
        const conversions = r != null
          ? parseInt(this.parsePerformanceNumber(get(r, 'purchasesClicks', 'purchases_clicks', 'purchases')), 10) || 0
          : 0;
        const salesVal = r != null
          ? this.parsePerformanceNumber(get(r, 'salesClicks', 'sales_clicks', 'sales'))
          : 0;

        await db.query(
          `INSERT INTO campaign_performance (
            campaign_id, report_date, impressions, clicks, cost,
            attributed_conversions_1d, attributed_conversions_7d,
            attributed_conversions_14d, attributed_conversions_30d,
            attributed_sales_1d, attributed_sales_7d,
            attributed_sales_14d, attributed_sales_30d
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (campaign_id, report_date)
          DO UPDATE SET
            impressions = $3,
            clicks = $4,
            cost = $5,
            attributed_conversions_1d = $6,
            attributed_conversions_7d = $7,
            attributed_conversions_14d = $8,
            attributed_conversions_30d = $9,
            attributed_sales_1d = $10,
            attributed_sales_7d = $11,
            attributed_sales_14d = $12,
            attributed_sales_30d = $13,
            updated_at = CURRENT_TIMESTAMP`,
          [
            campaignId,
            dbDate,
            impressions,
            clicks,
            cost,
            0,           // attributed_conversions_1d — not in SD report
            conversions, // attributed_conversions_7d
            conversions, // attributed_conversions_14d
            0,           // attributed_conversions_30d — not in SD report
            0,           // attributed_sales_1d
            salesVal,    // attributed_sales_7d
            salesVal,    // attributed_sales_14d
            0            // attributed_sales_30d — not in SD report
          ]
        );
        synced++;
        if (synced % 10 === 0 || synced === total) {
          logger.info(`📊 [SD CAMPAIGNS] Progress: ${synced}/${total} records (${Math.round(synced / total * 100)}%)`);
        }
      }

      logger.info(`✅ [SD CAMPAIGNS] Synced ${synced} SD campaign performance records for ${reportDate}`);
      return synced;
    } catch (error) {
      logger.error(`❌ [SD CAMPAIGNS] Error syncing SD campaign performance:`, error.message);
      throw error;
    }
  }

  /**
   * Sync performance data for ad groups
   * v3 API now returns campaignId in report data
   */
  async syncAdGroupPerformance(reportDate) {
    try {
      logger.info(`📊 [AD GROUPS] Syncing ad group performance for ${reportDate}...`);
      logger.info(`📊 [AD GROUPS] Requesting report from Amazon Ads API...`);
      
      const reportData = await this.client.getPerformanceData('adGroups', reportDate, reportDate);

      if (!reportData || reportData.length === 0) {
        logger.warn(`⚠️  [AD GROUPS] No ad group performance data returned for ${reportDate}`);
        return 0;
      }

      logger.info(`📊 [AD GROUPS] Received ${reportData.length} records, saving to database...`);
      
      const dbDate = this.formatDateForDB(reportDate);
      let synced = 0;
      let skipped = 0;
      const total = reportData.length;

      // Build lookup for ad groups if campaignId not in report
      const adGroupResult = await db.query('SELECT ad_group_id, campaign_id FROM ad_groups');
      const adGroupToCampaign = {};
      adGroupResult.rows.forEach(r => {
        adGroupToCampaign[String(r.ad_group_id)] = r.campaign_id;
      });

      for (const record of reportData) {
        if (!record.adGroupId) continue;

        // Use campaignId from report if available, otherwise lookup from database
        let campaignId = record.campaignId;
        if (!campaignId) {
          campaignId = adGroupToCampaign[String(record.adGroupId)];
          if (!campaignId) {
            logger.debug(`Skipping ad group performance for ${record.adGroupId} - ad group not found in database`);
            skipped++;
            continue;
          }
        }

        await db.query(
          `INSERT INTO ad_group_performance (
            campaign_id, ad_group_id, report_date,
            impressions, clicks, cost,
            attributed_conversions_1d, attributed_conversions_7d,
            attributed_sales_1d, attributed_sales_7d
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (ad_group_id, report_date)
          DO UPDATE SET
            campaign_id = $1,
            impressions = $4,
            clicks = $5,
            cost = $6,
            attributed_conversions_1d = $7,
            attributed_conversions_7d = $8,
            attributed_sales_1d = $9,
            attributed_sales_7d = $10,
            updated_at = CURRENT_TIMESTAMP`,
          [
            campaignId,
            record.adGroupId,
            dbDate,
            record.impressions || 0,
            record.clicks || 0,
            record.cost || 0,
            record.purchases1d || 0,  // API v3 returns purchases1d
            record.purchases7d || 0,  // API v3 returns purchases7d
            record.sales1d || 0,      // API v3 returns sales1d
            record.sales7d || 0       // API v3 returns sales7d
          ]
        );
        synced++;
        
        // Log progress every 50 records
        if (synced % 50 === 0) {
          logger.info(`📊 [AD GROUPS] Progress: ${synced}/${total} records saved`);
        }
      }

      logger.info(`✅ [AD GROUPS] Successfully synced ${synced} ad group performance records for ${reportDate}, skipped ${skipped}`);
      return synced;
    } catch (error) {
      logger.error(`❌ [AD GROUPS] Error syncing ad group performance:`, error.message);
      throw error;
    }
  }

  /**
   * Helper to get value from record with multiple possible keys (camelCase/snake_case).
   */
  _getReportValue(record, ...keys) {
    if (record == null) return undefined;
    for (const k of keys) {
      const v = record[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  /**
   * Sync Sponsored Brands ad group performance into ad_group_performance.
   * The Amazon Ads Reporting API for SPONSORED_BRANDS (sbCampaigns) does NOT support groupBy: ['adGroup']
   * or columns adGroupId/adGroupName — only groupBy: ['campaign'] is allowed. So we cannot fetch
   * SB ad group-level performance; we skip the API call to avoid 400 errors.
   */
  async syncSBAdGroupPerformance(reportDate) {
    logger.info(`📊 [SB AD GROUPS] Skipping SB ad group performance (Reporting API supports campaign-level only for SB)`);
    return 0;
  }

  /**
   * Sync Sponsored Display ad group performance into ad_group_performance.
   * The Amazon Ads Reporting API for SPONSORED_DISPLAY (sdCampaigns) does NOT support groupBy: ['adGroup']
   * or columns adGroupId/adGroupName — only groupBy: ['campaign'] or ['matchedTarget'] is allowed. So we
   * cannot fetch SD ad group-level performance; we skip the API call to avoid 400 errors.
   */
  async syncSDAdGroupPerformance(reportDate) {
    logger.info(`📊 [SD AD GROUPS] Skipping SD ad group performance (Reporting API supports campaign/matchedTarget only for SD)`);
    return 0;
  }

  /**
   * Sync performance data for keywords
   * v3 API now returns campaignId and adGroupId in report data
   */
  async syncKeywordPerformance(reportDate) {
    try {
      logger.info(`📊 [KEYWORDS] Syncing keyword performance for ${reportDate}...`);
      logger.info(`📊 [KEYWORDS] Requesting report from Amazon Ads API...`);
      
      const reportData = await this.client.getPerformanceData('keywords', reportDate, reportDate);

      if (!reportData || reportData.length === 0) {
        logger.warn(`⚠️  [KEYWORDS] No keyword performance data returned for ${reportDate}`);
        return 0;
      }

      logger.info(`📊 [KEYWORDS] Received ${reportData.length} records, saving to database...`);
      
      const dbDate = this.formatDateForDB(reportDate);
      let synced = 0;
      let skipped = 0;
      const total = reportData.length;

      // Build lookup for keywords if data not in report
      const keywordResult = await db.query('SELECT keyword_id, campaign_id, ad_group_id FROM keywords');
      const keywordData = {};
      keywordResult.rows.forEach(r => {
        keywordData[String(r.keyword_id)] = { campaign_id: r.campaign_id, ad_group_id: r.ad_group_id };
      });

      for (const record of reportData) {
        if (!record.keywordId) continue;

        // Use data from report if available, otherwise lookup from database
        let campaignId = record.campaignId;
        let adGroupId = record.adGroupId;
        
        // Check if keyword exists in database (required for foreign key constraint)
        const kwData = keywordData[String(record.keywordId)];
        if (!kwData) {
          // This is likely a product target, not a keyword - skip it
          skipped++;
          continue;
        }
        
        // Use lookup data if not provided in report
        campaignId = campaignId || kwData.campaign_id;
        adGroupId = adGroupId || kwData.ad_group_id;

        try {
          await db.query(
            `INSERT INTO keyword_performance (
              campaign_id, ad_group_id, keyword_id, report_date,
              impressions, clicks, cost,
              attributed_conversions_1d, attributed_conversions_7d,
              attributed_sales_1d, attributed_sales_7d
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (keyword_id, report_date)
            DO UPDATE SET
              campaign_id = $1,
              ad_group_id = $2,
              impressions = $5,
              clicks = $6,
              cost = $7,
              attributed_conversions_1d = $8,
              attributed_conversions_7d = $9,
              attributed_sales_1d = $10,
              attributed_sales_7d = $11,
              updated_at = CURRENT_TIMESTAMP`,
            [
              campaignId,
              adGroupId,
              record.keywordId,
              dbDate,
              record.impressions || 0,
              record.clicks || 0,
              record.cost || 0,
              record.purchases1d || 0,  // API v3 returns purchases1d
              record.purchases7d || 0,  // API v3 returns purchases7d
              record.sales1d || 0,      // API v3 returns sales1d
              record.sales7d || 0       // API v3 returns sales7d
            ]
          );
          synced++;
        } catch (dbError) {
          // Handle foreign key constraint errors gracefully
          if (dbError.message.includes('foreign key constraint')) {
            skipped++;
            continue;
          }
          throw dbError;
        }
        
        // Log progress every 100 records
        if (synced % 100 === 0) {
          logger.info(`📊 [KEYWORDS] Progress: ${synced}/${total} records saved`);
        }
      }

      logger.info(`✅ [KEYWORDS] Successfully synced ${synced} keyword performance records for ${reportDate}, skipped ${skipped}`);
      return synced;
    } catch (error) {
      logger.error(`❌ [KEYWORDS] Error syncing keyword performance:`, error.message);
      throw error;
    }
  }

  /**
   * Sync product ads data using v3 API
   * Product ads link products (ASINs) to ad groups
   */
  async syncProductAds() {
    try {
      logger.info('📋 Syncing product ads from Amazon Ads API v3...');
      const productAds = await this.client.getProductAds();

      if (!productAds || productAds.length === 0) {
        logger.warn('⚠️  No product ads returned from API');
        return 0;
      }

      logger.info(`📥 Retrieved ${productAds.length} product ads, saving to database...`);

      // Build lookup for existing campaigns and ad groups
      const campaignResult = await db.query('SELECT campaign_id FROM campaigns');
      const adGroupResult = await db.query('SELECT ad_group_id FROM ad_groups');
      const campaignIds = new Set(campaignResult.rows.map(r => String(r.campaign_id)));
      const adGroupIds = new Set(adGroupResult.rows.map(r => String(r.ad_group_id)));

      let synced = 0;
      let skipped = 0;
      let errors = 0;

      for (const ad of productAds) {
        try {
          // Validate required fields
          if (!ad.adId) {
            logger.warn('Skipping product ad without adId:', ad);
            errors++;
            continue;
          }
          
          if (!ad.campaignId || !ad.adGroupId) {
            logger.warn(`Skipping product ad ${ad.adId} without campaignId or adGroupId`);
            errors++;
            continue;
          }
          
        // Check if campaign and ad group exist
          const campaignIdStr = String(ad.campaignId);
          const adGroupIdStr = String(ad.adGroupId);
          
          if (!campaignIds.has(campaignIdStr)) {
          logger.debug(`Skipping product ad ${ad.adId} - campaign ${ad.campaignId} not found`);
          skipped++;
          continue;
        }

          if (!adGroupIds.has(adGroupIdStr)) {
          logger.debug(`Skipping product ad ${ad.adId} - ad group ${ad.adGroupId} not found`);
          skipped++;
          continue;
        }

        await db.query(
          `INSERT INTO product_ads (
            ad_id, campaign_id, ad_group_id, asin, sku, state
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (ad_id)
          DO UPDATE SET
            campaign_id = $2,
            ad_group_id = $3,
            asin = $4,
            sku = $5,
            state = $6,
            updated_at = CURRENT_TIMESTAMP`,
          [
              String(ad.adId), // BIGINT as string
              campaignIdStr,
              adGroupIdStr,
            ad.asin || null,
            ad.sku || null,
              (ad.state || 'ENABLED').toUpperCase() // Store in uppercase
          ]
        );
        synced++;

        if (synced % 100 === 0) {
          logger.info(`📋 Product ads progress: ${synced}/${productAds.length}`);
          }
        } catch (error) {
          logger.error(`Error syncing product ad ${ad.adId}:`, error.message);
          errors++;
        }
      }

      logger.info(`✅ Synced ${synced} product ads, skipped ${skipped}${errors > 0 ? `, ${errors} errors` : ''}`);
      return synced;
    } catch (error) {
      logger.error('❌ Error syncing product ads:', error.message);
      throw error;
    }
  }

  /**
   * Sync search term performance data
   * Used for negative keyword analysis and search term harvesting
   */
  async syncSearchTermPerformance(reportDate) {
    try {
      logger.info(`📊 [SEARCH TERMS] Syncing search term performance for ${reportDate}...`);
      
      const reportData = await this.client.getSearchTermPerformanceData(reportDate);

      if (!reportData || reportData.length === 0) {
        logger.warn(`⚠️  [SEARCH TERMS] No search term data returned for ${reportDate}`);
        return 0;
      }

      logger.info(`📊 [SEARCH TERMS] Received ${reportData.length} records, saving to database...`);
      
      const dbDate = this.formatDateForDB(reportDate);
      let synced = 0;
      let skipped = 0;

      for (const record of reportData) {
        if (!record.searchTerm) continue;

        await db.query(
          `INSERT INTO search_term_performance (
            campaign_id, ad_group_id, keyword_id, search_term, report_date,
            impressions, clicks, cost,
            attributed_conversions_1d, attributed_conversions_7d,
            attributed_sales_1d, attributed_sales_7d
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (search_term, keyword_id, report_date)
          DO UPDATE SET
            campaign_id = $1,
            ad_group_id = $2,
            impressions = $6,
            clicks = $7,
            cost = $8,
            attributed_conversions_1d = $9,
            attributed_conversions_7d = $10,
            attributed_sales_1d = $11,
            attributed_sales_7d = $12,
            updated_at = CURRENT_TIMESTAMP`,
          [
            record.campaignId,
            record.adGroupId,
            record.keywordId || null,
            record.searchTerm,
            dbDate,
            record.impressions || 0,
            record.clicks || 0,
            record.cost || 0,
            record.purchases1d || 0,
            record.purchases7d || 0,
            record.sales1d || 0,
            record.sales7d || 0
          ]
        );
        synced++;

        if (synced % 500 === 0) {
          logger.info(`📊 [SEARCH TERMS] Progress: ${synced}/${reportData.length} records saved`);
        }
      }

      logger.info(`✅ [SEARCH TERMS] Successfully synced ${synced} search term records for ${reportDate}`);
      return synced;
    } catch (error) {
      logger.error(`❌ [SEARCH TERMS] Error syncing search term performance:`, error.message);
      throw error;
    }
  }

  /**
   * Sync negative keywords from Amazon Ads
   */
  async syncNegativeKeywords() {
    try {
      logger.info('📋 Syncing negative keywords from Amazon Ads API v3...');
      
      const [adGroupNegatives, campaignNegatives] = await Promise.all([
        this.client.getNegativeKeywords(),
        this.client.getCampaignNegativeKeywords()
      ]);

      logger.info(`📥 Retrieved ${adGroupNegatives.length} ad group negatives, ${campaignNegatives.length} campaign negatives`);

      // For now, just log - the negative_keyword_history table is used by the AI rule engine
      // We could store these for reference if needed
      
      return adGroupNegatives.length + campaignNegatives.length;
    } catch (error) {
      logger.error('❌ Error syncing negative keywords:', error.message);
      throw error;
    }
  }

  /**
   * Sync Sponsored Brands campaigns using v4 API (GET /sb/v4/campaigns)
   */
  async syncSponsoredBrandsCampaigns() {
    try {
      logger.info('📋 Syncing Sponsored Brands campaigns from Amazon Ads API v4...');
      const campaigns = await this.client.getAllSBCampaigns();

      if (!campaigns || campaigns.length === 0) {
        logger.warn('⚠️  No Sponsored Brands campaigns returned from API');
        return 0;
      }

      logger.info(`📥 Retrieved ${campaigns.length} SB campaigns, saving to database...`);

      let synced = 0;
      let errors = 0;
      
      for (const campaign of campaigns) {
        try {
          if (!campaign.campaignId) {
            logger.warn('Skipping SB campaign without campaignId:', campaign);
            errors++;
            continue;
          }
          
          const campaignId = String(campaign.campaignId);
          const campaignName = campaign.name || 'Unnamed SB Campaign';
          const campaignState = (campaign.state || 'ENABLED').toUpperCase();
          const targetingType = campaign.targetingType || 'MANUAL';
          const startDate = campaign.startDate || null;
          const endDate = campaign.endDate || null;
          
          let budgetAmount = null;
          let budgetType = 'DAILY';
          
          if (campaign.budget) {
            budgetAmount = campaign.budget.budget || campaign.budget.budgetAmount || null;
            budgetType = campaign.budget.budgetType || campaign.budget.type || 'DAILY';
          }

          const portfolioId = campaign.portfolioId ? String(campaign.portfolioId) : null;
          const campaignType = 'SB';
          // Extract SB ad type: PRODUCT_COLLECTION, STORE_SPOTLIGHT, VIDEO
          const sbAdType = campaign.adFormat || campaign.creativeType || 
                          (campaign.creative?.type) || null;

          await db.query(
            `INSERT INTO campaigns (
              campaign_id, campaign_name, campaign_status, 
              targeting_type, start_date, end_date,
              budget_amount, budget_type, portfolio_id,
              campaign_type, sb_ad_type
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (campaign_id) 
            DO UPDATE SET
              campaign_name = $2,
              campaign_status = $3,
              targeting_type = $4,
              start_date = $5,
              end_date = $6,
              budget_amount = $7,
              budget_type = $8,
              portfolio_id = $9,
              campaign_type = $10,
              sb_ad_type = $11,
              updated_at = CURRENT_TIMESTAMP`,
            [
              campaignId, campaignName, campaignState,
              targetingType, startDate, endDate,
              budgetAmount, budgetType, portfolioId,
              campaignType, sbAdType
            ]
          );
          synced++;
        } catch (error) {
          logger.error(`Error syncing SB campaign ${campaign.campaignId}:`, error.message);
          errors++;
        }
      }

      logger.info(`✅ Synced ${synced} Sponsored Brands campaigns${errors > 0 ? `, ${errors} errors` : ''}`);
      return synced;
    } catch (error) {
      logger.error('❌ Error syncing Sponsored Brands campaigns:', error.message);
      throw error;
    }
  }

  /**
   * Sync Sponsored Display campaigns using v3 API
   */
  async syncSponsoredDisplayCampaigns() {
    try {
      logger.info('📋 Syncing Sponsored Display campaigns from Amazon Ads API v3...');
      const campaigns = await this.client.getAllSponsoredDisplayCampaigns();

      if (!campaigns || campaigns.length === 0) {
        logger.warn('⚠️  No Sponsored Display campaigns returned from API');
        return 0;
      }

      logger.info(`📥 Retrieved ${campaigns.length} SD campaigns, saving to database...`);

      let synced = 0;
      let errors = 0;
      
      for (const campaign of campaigns) {
        try {
          if (!campaign.campaignId) {
            logger.warn('Skipping SD campaign without campaignId:', campaign);
            errors++;
            continue;
          }
          
          const campaignId = String(campaign.campaignId);
          const campaignName = campaign.name || 'Unnamed SD Campaign';
          const campaignState = (campaign.state || 'ENABLED').toUpperCase();
          const targetingType = campaign.targetingType || 'MANUAL';
          const startDate = campaign.startDate || null;
          const endDate = campaign.endDate || null;
          
          let budgetAmount = null;
          let budgetType = 'DAILY';
          
          if (campaign.budget) {
            budgetAmount = campaign.budget.budget || campaign.budget.budgetAmount || null;
            budgetType = campaign.budget.budgetType || campaign.budget.type || 'DAILY';
          }

          const portfolioId = campaign.portfolioId ? String(campaign.portfolioId) : null;
          const campaignType = 'SD';
          // Extract SD targeting type: CONTEXTUAL, AUDIENCES
          const sdTargetingType = campaign.targetingType === 'AUDIENCES' ? 'AUDIENCES' :
                                 campaign.targetingType === 'CONTEXTUAL' ? 'CONTEXTUAL' :
                                 campaign.targeting?.type || null;

          await db.query(
            `INSERT INTO campaigns (
              campaign_id, campaign_name, campaign_status, 
              targeting_type, start_date, end_date,
              budget_amount, budget_type, portfolio_id,
              campaign_type, sd_targeting_type
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (campaign_id) 
            DO UPDATE SET
              campaign_name = $2,
              campaign_status = $3,
              targeting_type = $4,
              start_date = $5,
              end_date = $6,
              budget_amount = $7,
              budget_type = $8,
              portfolio_id = $9,
              campaign_type = $10,
              sd_targeting_type = $11,
              updated_at = CURRENT_TIMESTAMP`,
            [
              campaignId, campaignName, campaignState,
              targetingType, startDate, endDate,
              budgetAmount, budgetType, portfolioId,
              campaignType, sdTargetingType
            ]
          );
          synced++;
        } catch (error) {
          logger.error(`Error syncing SD campaign ${campaign.campaignId}:`, error.message);
          errors++;
        }
      }

      logger.info(`✅ Synced ${synced} Sponsored Display campaigns${errors > 0 ? `, ${errors} errors` : ''}`);
      return synced;
    } catch (error) {
      logger.error('❌ Error syncing Sponsored Display campaigns:', error.message);
      throw error;
    }
  }

  /**
   * Sync product targeting (ASINs and Categories) using v3 API
   */
  async syncProductTargets() {
    try {
      logger.info('📋 Syncing product targets from Amazon Ads API v3...');
      const targets = await this.client.getTargets();

      if (!targets || targets.length === 0) {
        logger.warn('⚠️  No product targets returned from API');
        return 0;
      }

      logger.info(`📥 Retrieved ${targets.length} product targets, saving to database...`);

      // Build lookup for existing campaigns and ad groups
      const campaignResult = await db.query('SELECT campaign_id FROM campaigns');
      const adGroupResult = await db.query('SELECT ad_group_id FROM ad_groups');
      const campaignIds = new Set(campaignResult.rows.map(r => String(r.campaign_id)));
      const adGroupIds = new Set(adGroupResult.rows.map(r => String(r.ad_group_id)));

      let synced = 0;
      let skipped = 0;
      let errors = 0;

      for (const target of targets) {
        try {
          if (!target.targetId) {
            logger.warn('Skipping product target without targetId:', target);
            errors++;
            continue;
          }
          
          if (!target.campaignId || !target.adGroupId) {
            logger.warn(`Skipping product target ${target.targetId} without campaignId or adGroupId`);
            errors++;
            continue;
          }
          
          const campaignIdStr = String(target.campaignId);
          const adGroupIdStr = String(target.adGroupId);
          
          if (!campaignIds.has(campaignIdStr)) {
            logger.debug(`Skipping product target ${target.targetId} - campaign ${target.campaignId} not found`);
            skipped++;
            continue;
          }

          if (!adGroupIds.has(adGroupIdStr)) {
            logger.debug(`Skipping product target ${target.targetId} - ad group ${target.adGroupId} not found`);
            skipped++;
            continue;
          }

          const targetId = String(target.targetId);
          // Determine target type: ASIN or CATEGORY
          const targetType = target.targetingExpression?.type || 
                           (target.asin ? 'ASIN' : 'CATEGORY');
          const targetValue = target.asin || target.categoryId || 
                            target.targetingExpression?.value || '';

          const bid = target.bid || null;
          const state = (target.state || 'ENABLED').toUpperCase();

          await db.query(
            `INSERT INTO product_targets (
              target_id, campaign_id, ad_group_id,
              target_type, target_value, bid, state
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (target_id)
            DO UPDATE SET
              campaign_id = $2,
              ad_group_id = $3,
              target_type = $4,
              target_value = $5,
              bid = $6,
              state = $7,
              updated_at = CURRENT_TIMESTAMP`,
            [
              targetId, campaignIdStr, adGroupIdStr,
              targetType, targetValue, bid, state
            ]
          );
          synced++;

          if (synced % 100 === 0) {
            logger.info(`📋 Product targets progress: ${synced}/${targets.length}`);
          }
        } catch (error) {
          logger.error(`Error syncing product target ${target.targetId}:`, error.message);
          errors++;
        }
      }

      logger.info(`✅ Synced ${synced} product targets, skipped ${skipped}${errors > 0 ? `, ${errors} errors` : ''}`);
      return synced;
    } catch (error) {
      logger.error('❌ Error syncing product targets:', error.message);
      throw error;
    }
  }

  /**
   * Sync ASIN-level performance data from the spAdvertisedProduct report.
   * Aggregates across ad groups so each (asin, report_date) row is unique.
   */
  async syncAsinPerformance(reportDate) {
    try {
      logger.info(`📊 [ASIN PERF] Syncing ASIN performance for ${reportDate}...`);

      const reportData = await this.client.getPerformanceData('productAds', reportDate, reportDate);

      if (!reportData || reportData.length === 0) {
        logger.warn(`⚠️  [ASIN PERF] No ASIN performance data returned for ${reportDate}`);
        return 0;
      }

      logger.info(`📊 [ASIN PERF] Received ${reportData.length} records, aggregating by ASIN...`);

      const dbDate = this.formatDateForDB(reportDate);

      // Aggregate by ASIN since multiple ads can share the same ASIN
      const asinMap = {};
      for (const record of reportData) {
        const asin = record.advertisedAsin || record.asin;
        if (!asin) continue;

        if (!asinMap[asin]) {
          asinMap[asin] = {
            impressions: 0,
            clicks: 0,
            cost: 0,
            attributedSales7d: 0,
            attributedConversions7d: 0,
          };
        }
        asinMap[asin].impressions += (record.impressions || 0);
        asinMap[asin].clicks += (record.clicks || 0);
        asinMap[asin].cost += parseFloat(record.cost || 0);
        asinMap[asin].attributedSales7d += parseFloat(record.sales7d || 0);
        asinMap[asin].attributedConversions7d += (record.purchases7d || 0);
      }

      const asins = Object.keys(asinMap);
      logger.info(`📊 [ASIN PERF] Aggregated to ${asins.length} unique ASINs, saving to database...`);

      let synced = 0;
      for (const asin of asins) {
        const d = asinMap[asin];
        try {
          await db.query(
            `INSERT INTO asin_performance (
              asin, report_date, impressions, clicks, cost,
              attributed_sales_7d, attributed_conversions_7d
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (asin, report_date)
            DO UPDATE SET
              impressions = $3,
              clicks = $4,
              cost = $5,
              attributed_sales_7d = $6,
              attributed_conversions_7d = $7,
              updated_at = CURRENT_TIMESTAMP`,
            [
              asin,
              dbDate,
              d.impressions,
              d.clicks,
              d.cost,
              d.attributedSales7d,
              d.attributedConversions7d,
            ]
          );
          synced++;
        } catch (dbError) {
          logger.error(`Error saving ASIN performance for ${asin}:`, dbError.message);
        }

        if (synced % 50 === 0 && synced > 0) {
          logger.info(`📊 [ASIN PERF] Progress: ${synced}/${asins.length} ASINs saved`);
        }
      }

      logger.info(`✅ [ASIN PERF] Successfully synced ${synced} ASIN performance records for ${reportDate}`);
      return synced;
    } catch (error) {
      logger.error(`❌ [ASIN PERF] Error syncing ASIN performance:`, error.message);
      throw error;
    }
  }

  /**
   * Auto-seed discovered ASINs into asin_cogs with default values.
   * Only inserts ASINs that don't already exist (ON CONFLICT DO NOTHING).
   */
  async syncAsinCogs() {
    try {
      logger.info('📋 [ASIN COGS] Seeding new ASINs into asin_cogs...');

      // Collect all unique ASINs from product_ads
      const result = await db.query(
        `SELECT DISTINCT asin FROM product_ads WHERE asin IS NOT NULL AND asin != ''`
      );

      if (!result.rows.length) {
        logger.info('📋 [ASIN COGS] No ASINs found in product_ads, skipping');
        return 0;
      }

      let inserted = 0;
      for (const row of result.rows) {
        try {
          const res = await db.query(
            `INSERT INTO asin_cogs (asin, cogs, amazon_fees_percentage, notes, created_by)
             VALUES ($1, 0, 0.15, 'Auto-seeded during sync', 'sync')
             ON CONFLICT (asin) DO NOTHING`,
            [row.asin]
          );
          if (res.rowCount > 0) inserted++;
        } catch (dbError) {
          logger.error(`Error seeding asin_cogs for ${row.asin}:`, dbError.message);
        }
      }

      logger.info(`✅ [ASIN COGS] Seeded ${inserted} new ASINs (${result.rows.length} total discovered)`);
      return inserted;
    } catch (error) {
      logger.error('❌ [ASIN COGS] Error seeding asin_cogs:', error.message);
      throw error;
    }
  }

  /**
   * Log sync operation
   */
  async logSync(syncType, status, recordsProcessed, errorMessage = null, startTime) {
    try {
      await db.query(
        `INSERT INTO sync_logs (
          sync_type, start_time, end_time, status,
          records_processed, error_message
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          syncType,
          startTime,
          new Date(),
          status,
          recordsProcessed,
          errorMessage
        ]
      );
    } catch (error) {
      logger.error('Error logging sync:', error);
    }
  }

  /**
   * Full sync - campaigns, ad groups, keywords, product ads, and performance data
   */
  async fullSync(daysBack = 7) {
    const startTime = new Date();
    const totalRecords = { campaigns: 0, adGroups: 0, keywords: 0, productAds: 0, performance: 0, asinPerformance: 0, asinCogs: 0 };

    try {
      logger.info('═══════════════════════════════════════════════════════');
      logger.info('🚀 STARTING FULL DATA SYNC (Amazon Ads API v3) - v2.0');
      logger.info(`📅 Syncing performance data for the last ${daysBack} days`);
      logger.info('═══════════════════════════════════════════════════════');

      // Sync metadata - v2.0: Include Portfolios, SB, SD, and Product Targeting
      logger.info('\n📋 PHASE 1: Syncing Metadata (v2.0)');
      logger.info('───────────────────────────────────────────────────────');
      
      // Sync portfolios first
      try {
        await this.syncPortfolios();
      } catch (error) {
        logger.warn(`⚠️  Portfolios sync skipped: ${error.message}`);
      }
      
      // Sync Sponsored Products campaigns and ad groups
      totalRecords.campaigns = await this.syncCampaigns();
      totalRecords.adGroups = await this.syncAdGroups();
      totalRecords.keywords = await this.syncKeywords();
      
      // Sync Sponsored Brands campaigns then ad groups
      try {
        const sbCampaigns = await this.syncSponsoredBrandsCampaigns();
        totalRecords.campaigns += sbCampaigns;
      } catch (error) {
        logger.warn(`⚠️  Sponsored Brands campaigns sync skipped: ${error.message}`);
      }
      try {
        const sbAdGroups = await this.syncSponsoredBrandsAdGroups();
        totalRecords.adGroups += sbAdGroups;
      } catch (error) {
        logger.warn(`⚠️  Sponsored Brands ad groups sync skipped: ${error.message}`);
      }
      
      // Sync Sponsored Display campaigns then ad groups
      try {
        const sdCampaigns = await this.syncSponsoredDisplayCampaigns();
        totalRecords.campaigns += sdCampaigns;
      } catch (error) {
        logger.warn(`⚠️  Sponsored Display campaigns sync skipped: ${error.message}`);
      }
      try {
        const sdAdGroups = await this.syncSponsoredDisplayAdGroups();
        totalRecords.adGroups += sdAdGroups;
      } catch (error) {
        logger.warn(`⚠️  Sponsored Display ad groups sync skipped: ${error.message}`);
      }
      
      // Try to sync product ads (may fail on some accounts)
      try {
        totalRecords.productAds = await this.syncProductAds();
      } catch (error) {
        logger.warn(`⚠️  Product ads sync skipped: ${error.message}`);
        totalRecords.productAds = 0;
      }
      
      // Sync product targeting
      try {
        await this.syncProductTargets();
      } catch (error) {
        logger.warn(`⚠️  Product targets sync skipped: ${error.message}`);
      }
      
      // Auto-seed discovered ASINs into asin_cogs
      try {
        totalRecords.asinCogs = await this.syncAsinCogs();
      } catch (error) {
        logger.warn(`⚠️  ASIN COGS seeding skipped: ${error.message}`);
      }
      
      logger.info(`✅ Metadata sync complete: ${totalRecords.campaigns} campaigns (SP+SB+SD), ${totalRecords.adGroups} ad groups, ${totalRecords.keywords} keywords, ${totalRecords.productAds} product ads`);

      // Sync performance data for the last N days
      logger.info('\n📊 PHASE 2: Syncing Performance Data');
      logger.info('───────────────────────────────────────────────────────');
      
      // TIMEZONE FIX: Always start from Yesterday (T-1) to ensure complete data
      // Amazon Ads data resets at midnight in marketplace timezone (PST/GMT)
      // Processing Yesterday ensures data is fully attributed and closed
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1); // Start from Yesterday (T-1)
      
      logger.info(`📅 Processing data starting from Yesterday (${yesterday.toISOString().split('T')[0]}) to ensure complete attribution`);
      
      const performancePromises = [];
      
      // Process each day sequentially to avoid overwhelming the API
      // Start from Yesterday and go back N days
      for (let i = 0; i < daysBack; i++) {
        const date = new Date(yesterday);
        date.setDate(date.getDate() - i);
        // Amazon Ads API expects date in YYYYMMDD format (e.g., 20241020)
        const reportDate = date.toISOString().split('T')[0].replace(/-/g, '');
        const displayDate = date.toISOString().split('T')[0];

        logger.info(`\n📅 Processing Day ${i + 1}/${daysBack}: ${displayDate}`);
        logger.info('─────────────────────────────────────────────────────');
        
        try {
          // Process campaigns first (SP), then SB campaign performance, then ad groups and keywords in parallel
          const campaignPerf = await this.syncCampaignPerformance(reportDate);
          let sbCampaignPerf = 0;
          try {
            sbCampaignPerf = await this.syncSBCampaignPerformance(reportDate);
          } catch (err) {
            logger.warn(`⚠️  SB campaign performance sync skipped for ${displayDate}: ${err.message}`);
          }
          let sdCampaignPerf = 0;
          try {
            sdCampaignPerf = await this.syncSDCampaignPerformance(reportDate);
          } catch (err) {
            logger.warn(`⚠️  SD campaign performance sync skipped for ${displayDate}: ${err.message}`);
          }

          // Process ad groups (SP + SB + SD), keywords, and ASIN performance in parallel
          const [adGroupPerf, sbAdGroupPerf, sdAdGroupPerf, keywordPerf, asinPerf] = await Promise.all([
            this.syncAdGroupPerformance(reportDate),
            this.syncSBAdGroupPerformance(reportDate).catch(err => {
              logger.warn(`⚠️  SB ad group performance sync skipped for ${displayDate}: ${err.message}`);
              return 0;
            }),
            this.syncSDAdGroupPerformance(reportDate).catch(err => {
              logger.warn(`⚠️  SD ad group performance sync skipped for ${displayDate}: ${err.message}`);
              return 0;
            }),
            this.syncKeywordPerformance(reportDate),
            this.syncAsinPerformance(reportDate).catch(err => {
              logger.warn(`⚠️  ASIN performance sync skipped for ${displayDate}: ${err.message}`);
              return 0;
            })
          ]);

          const dayTotal = campaignPerf + sbCampaignPerf + sdCampaignPerf + adGroupPerf + sbAdGroupPerf + sdAdGroupPerf + keywordPerf + asinPerf;
          totalRecords.performance += campaignPerf + sbCampaignPerf + sdCampaignPerf + adGroupPerf + sbAdGroupPerf + sdAdGroupPerf + keywordPerf;
          totalRecords.asinPerformance += asinPerf;
          
          logger.info(`✅ Day ${i + 1} complete: ${dayTotal} total records synced`);
        } catch (error) {
          logger.error(`❌ Day ${i + 1} failed:`, error.message);
          // Continue with next day instead of failing completely
          continue;
        }
      }

      const total = Object.values(totalRecords).reduce((a, b) => a + b, 0);
      const duration = ((new Date() - startTime) / 1000).toFixed(2);
      
      await this.logSync('full_sync', 'success', total, null, startTime);

      logger.info('\n═══════════════════════════════════════════════════════');
      logger.info('✅ FULL SYNC COMPLETED SUCCESSFULLY');
      logger.info('═══════════════════════════════════════════════════════');
      logger.info(`📊 Summary:`);
      logger.info(`   • Campaigns synced: ${totalRecords.campaigns}`);
      logger.info(`   • Ad Groups synced: ${totalRecords.adGroups}`);
      logger.info(`   • Keywords synced: ${totalRecords.keywords}`);
      logger.info(`   • Product Ads synced: ${totalRecords.productAds}`);
      logger.info(`   • Performance records: ${totalRecords.performance}`);
      logger.info(`   • ASIN Performance records: ${totalRecords.asinPerformance}`);
      logger.info(`   • ASIN COGS seeded: ${totalRecords.asinCogs}`);
      logger.info(`   • Total records: ${total}`);
      logger.info(`   • Duration: ${duration} seconds`);
      logger.info('═══════════════════════════════════════════════════════\n');
      
      return totalRecords;
    } catch (error) {
      const duration = ((new Date() - startTime) / 1000).toFixed(2);
      const total = Object.values(totalRecords).reduce((a, b) => a + b, 0);
      await this.logSync('full_sync', 'failed', total, error.message, startTime);
      
      logger.error('\n═══════════════════════════════════════════════════════');
      logger.error('❌ FULL SYNC FAILED');
      logger.error('═══════════════════════════════════════════════════════');
      logger.error(`Error: ${error.message}`);
      logger.error(`Duration before failure: ${duration} seconds`);
      logger.error('═══════════════════════════════════════════════════════\n');
      
      // Don't throw the error if we've synced some data successfully
      if (total > 0) {
        logger.warn(`⚠️  Partial sync completed: ${total} records synced before failure`);
        return totalRecords;
      }
      
      throw error;
    }
  }
}

module.exports = DataSyncService;