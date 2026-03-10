const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/config');

/**
 * Amazon Ads API Client
 * 
 * Uses Amazon Ads API v3 (current stable version)
 * - For entity management (campaigns, ad groups, keywords): Sponsored Products v3 endpoints
 * - For reporting: Reporting v3 endpoints
 * 
 * API Documentation: https://advertising.amazon.com/API/docs/en-us/
 */
class AmazonAdsClient {
  constructor() {
    this.accessToken = null;
    this.tokenExpiry = null;
    this.config = config.amazon;
  }

  /**
   * Refresh the access token using the refresh token
   */
  async refreshAccessToken() {
    try {
      logger.info('Refreshing Amazon Ads API access token...');

      // Validate required credentials
      if (!this.config.refreshToken) {
        throw new Error('AMAZON_REFRESH_TOKEN is not configured. Please check your .env file.');
      }
      if (!this.config.clientId) {
        throw new Error('AMAZON_CLIENT_ID is not configured. Please check your .env file.');
      }
      if (!this.config.clientSecret) {
        throw new Error('AMAZON_CLIENT_SECRET is not configured. Please check your .env file.');
      }

      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.config.refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret
      });

      const response = await axios.post(this.config.tokenEndpoint, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
      });

      this.accessToken = response.data.access_token;
      // Set token expiry (default to 1 hour minus 5 minutes for safety)
      this.tokenExpiry = Date.now() + ((response.data.expires_in || 3600) - 300) * 1000;

      logger.info('Access token refreshed successfully');
      return this.accessToken;
    } catch (error) {
      const errorData = error.response?.data || {};
      const errorMessage = errorData.error_description || errorData.error || error.message;
      
      // Provide helpful error messages for common issues
      if (errorData.error === 'invalid_grant') {
        logger.error('Refresh token is invalid or expired. Please generate a new refresh token.');
        throw new Error('Invalid or expired refresh token. Please regenerate your Amazon Ads API credentials. ' +
          'Visit: https://advertising.amazon.com/API/docs/en-us/setting-up/step-1-create-an-application');
      }
      
      logger.error('Error refreshing access token:', errorData);
      throw new Error('Failed to refresh access token: ' + errorMessage);
    }
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getAccessToken() {
    if (!this.accessToken || Date.now() >= this.tokenExpiry) {
      await this.refreshAccessToken();
    }
    return this.accessToken;
  }

  /**
   * Make an authenticated API request with retry logic
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {object} data - Request body data
   * @param {object} params - Query parameters
   * @param {number} retries - Number of retries
   * @param {number} baseDelay - Base delay for exponential backoff
   * @param {object} customHeaders - Custom headers to override defaults
   */
  async makeRequest(method, endpoint, data = null, params = null, retries = 3, baseDelay = 1000, customHeaders = {}) {
    const maxRetries = retries;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const token = await this.getAccessToken();

        const headers = {
          'Authorization': `Bearer ${token}`,
          'Amazon-Advertising-API-ClientId': this.config.clientId,
          'Amazon-Advertising-API-Scope': this.config.profileId,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...customHeaders  // Allow custom headers to override defaults
        };

        const requestConfig = {
          method,
          url: `${this.config.endpoint}${endpoint}`,
          headers,
          params,
          timeout: 60000 // 60 second timeout for large requests
        };

        if (data) {
          requestConfig.data = data;
        }

        if (attempt > 0) {
          logger.info(`Retrying API request (attempt ${attempt + 1}/${maxRetries + 1}): ${method} ${endpoint}`);
        } else {
          logger.debug(`Making API request: ${method} ${this.config.endpoint}${endpoint}`, { params });
        }

        const response = await axios(requestConfig);
        return response.data;
      } catch (error) {
        lastError = error;
        
        // Don't retry on client errors (4xx) except for specific cases
        if (error.response?.status) {
          const status = error.response.status;
          
          // Handle duplicate report requests - extract the duplicate report ID
          if (status === 425) {
            const errorDetail = error.response.data?.detail || '';
            const reportIdMatch = errorDetail.match(/duplicate of : ([a-f0-9-]+)/);
            if (reportIdMatch) {
              const duplicateReportId = reportIdMatch[1];
              logger.info(`Report request is a duplicate of existing report: ${duplicateReportId}`);
              logger.info(`Using existing report instead of creating a new one`);
              return { reportId: duplicateReportId };
            }
            throw new Error(`Duplicate request detected: ${errorDetail}`);
          }
          
          // Handle Not Acceptable (406) - common when Accept header doesn't match
          if (status === 406) {
            const errorDetail = error.response?.data || {};
            const endpointLower = String(endpoint).toLowerCase();
            // Suggest a likely vendor-specific header based on endpoint path
            let suggestedHeader = "application/vnd.spcampaign.v3+json"; // default
            if (endpointLower.includes('/sb/v4/')) {
              suggestedHeader = 'application/vnd.sbcampaignresource.v4+json';
            } else if (endpointLower.includes('/sb/')) {
              suggestedHeader = 'application/vnd.sbcampaign.v3+json';
            } else if (endpointLower.includes('/sd/')) {
              suggestedHeader = 'application/vnd.sdcampaign.v3+json';
            } else if (endpointLower.includes('/sp/targets')) {
              suggestedHeader = 'application/vnd.sptargetingClause.v3+json';
            } else if (endpointLower.includes('/sp/') && endpointLower.includes('campaign')) {
              suggestedHeader = 'application/vnd.spcampaign.v3+json';
            }

            throw new Error(`Not Acceptable (406) - No matching 'Accept' header for endpoint ${endpoint}. Server detail: ${JSON.stringify(errorDetail)}. Try using vendor-specific Accept header (e.g., '${suggestedHeader}').`);
          }

          // Don't retry on these status codes
          if ([400, 401, 403, 404, 415].includes(status)) {
            const errorDetail = error.response?.data;
            if (status === 404) {
              throw new Error(`API endpoint not found: ${endpoint}. Please check if the API version is correct.`);
            } else if (status === 401) {
              throw new Error('Authentication failed. Please check your API credentials.');
            } else if (status === 403) {
              throw new Error('Access forbidden. Please check your API permissions and profile ID.');
            } else if (status === 415) {
              throw new Error(`Unsupported Media Type (415) - Endpoint: ${method} ${endpoint}. Error: ${JSON.stringify(errorDetail)}`);
            } else if (status === 400) {
              logger.error(`Bad Request (400) - Endpoint: ${method} ${endpoint}`, errorDetail);
              throw new Error(`Bad Request: ${JSON.stringify(errorDetail)}`);
            }
            throw error;
          }
          
          // Retry on 429 (rate limit) and 5xx errors
          if (status === 429 || status >= 500) {
            if (attempt < maxRetries) {
              const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000; // Exponential backoff with jitter
              logger.warn(`API request failed with status ${status}, retrying in ${Math.round(delay)}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
          }
        }
        
        // Retry on network errors (socket hang up, timeout, etc.)
        const isNetworkError = !error.response && (
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND' ||
          error.message?.includes('socket hang up') ||
          error.message?.includes('timeout')
        );
        
        if (isNetworkError && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000; // Exponential backoff with jitter
          logger.warn(`Network error (${error.code || error.message}), retrying in ${Math.round(delay)}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // If we get here, either we've exhausted retries or it's a non-retryable error
        logger.error(`API request failed: ${method} ${endpoint}`, {
          error: error.response?.data || error.message,
          status: error.response?.status,
          url: `${this.config.endpoint}${endpoint}`,
          attempts: attempt + 1
        });
        
        throw error;
      }
    }
    
    // Should never reach here, but just in case
    throw lastError;
  }

  /**
   * Helper method to handle pagination for API v3 POST-based list requests
   * Amazon Ads API v3 uses cursor-based pagination with POST requests
   * @param {string} endpoint - API endpoint
   * @param {object} requestBody - Request body
   * @param {object} customHeaders - Custom headers (e.g., Accept header for v3 API)
   */
  async getAllPaginatedDataV3(endpoint, requestBody = {}, customHeaders = {}) {
    const allData = [];
    let nextToken = null;
    const maxResults = 1000; // Max allowed per request
    let pageCount = 0;
    const maxPages = 1000; // Safety limit to prevent infinite loops

    do {
      pageCount++;
      
      // Safety check to prevent infinite loops
      if (pageCount > maxPages) {
        logger.warn(`Reached maximum page limit (${maxPages}), stopping pagination`);
        break;
      }
      
      const body = {
        ...requestBody,
        maxResults
      };

      // Add pagination token if we have one
      if (nextToken) {
        body.nextToken = nextToken;
      }

      logger.debug(`Fetching page ${pageCount} from ${endpoint}...`);
      
      try {
        const response = await this.makeRequest('POST', endpoint, body, null, 3, 1000, customHeaders);
        
        if (!response) {
          logger.warn(`Empty response from ${endpoint} on page ${pageCount}`);
          break;
        }
        
        // V3 API returns data in different structures depending on endpoint
        // Most list endpoints return { campaigns: [], nextToken } or similar
        const responseData = response;
        
        // Extract the data array from response (could be campaigns, adGroups, keywords, etc.)
        let dataArray = [];
        
        if (Array.isArray(responseData)) {
          // Some endpoints return an array directly
          dataArray = responseData;
        } else if (typeof responseData === 'object') {
          // Try known field names first
          if (responseData.campaigns) {
            dataArray = responseData.campaigns;
          } else if (responseData.adGroups) {
            dataArray = responseData.adGroups;
          } else if (responseData.keywords) {
            dataArray = responseData.keywords;
          } else if (responseData.productAds) {
            dataArray = responseData.productAds;
          } else if (responseData.targets) {
            dataArray = responseData.targets;
          } else if (responseData.negativeKeywords) {
            dataArray = responseData.negativeKeywords;
          } else if (responseData.campaignNegativeKeywords) {
            dataArray = responseData.campaignNegativeKeywords;
          } else if (responseData.portfolios) {
            dataArray = responseData.portfolios;
          } else {
            // Try to find any array in the response (excluding nextToken)
            const keys = Object.keys(responseData).filter(k => k !== 'nextToken');
            for (const key of keys) {
              if (Array.isArray(responseData[key])) {
                dataArray = responseData[key];
                logger.debug(`Found data array in field: ${key}`);
                break;
              }
            }
          }
        }

        // Validate and add data
        if (Array.isArray(dataArray) && dataArray.length > 0) {
          allData.push(...dataArray);
          logger.debug(`Page ${pageCount}: Retrieved ${dataArray.length} records`);
        } else if (pageCount === 1) {
          // First page with no data - might be empty result set
          logger.info(`No data returned from ${endpoint}`);
          break;
        }

        // Get next page token
        const previousToken = nextToken;
        nextToken = responseData.nextToken || null;
        
        // Safety check: if nextToken is the same as previous, stop to prevent infinite loop
        if (nextToken && nextToken === previousToken) {
          logger.warn(`Duplicate nextToken detected, stopping pagination to prevent infinite loop`);
          break;
        }

        // Log progress for large datasets
        if (allData.length % 1000 === 0 && allData.length > 0) {
          logger.info(`Retrieved ${allData.length} records so far...`);
        }
      } catch (error) {
        logger.error(`Error fetching page ${pageCount} from ${endpoint}:`, error.message);
        // If we have some data, return it; otherwise rethrow
        if (allData.length > 0) {
          logger.warn(`Returning ${allData.length} records fetched before error`);
          break;
        }
        throw error;
      }

    } while (nextToken);

    logger.info(`Total records retrieved from ${endpoint}: ${allData.length} (${pageCount} pages)`);
    return allData;
  }

  /**
   * Normalize `requestBody.stateFilter.include` to an array of uppercase allowed states.
   * Accepts string (comma/space-separated), array, or 'ALL'. Filters to known set: ENABLED, PAUSED, ARCHIVED.
   */
  normalizeStateFilter(requestBody = {}) {
    const allowed = ['ENABLED', 'PAUSED', 'ARCHIVED'];
    if (!requestBody.stateFilter || requestBody.stateFilter.include === undefined || requestBody.stateFilter.include === null) return requestBody;
    let include = requestBody.stateFilter.include;
    // Accept comma or whitespace separated strings
    if (typeof include === 'string') {
      include = include.split(/[,\s]+/).filter(Boolean);
    }
    if (!Array.isArray(include)) {
      include = [include];
    }
    include = include.map(s => String(s).trim().toUpperCase());
    // Expand 'ALL' to all allowed states
    if (include.includes('ALL')) {
      include = [...allowed];
    }
    // Keep only allowed states
    include = include.filter(s => allowed.includes(s));
    return { ...requestBody, stateFilter: { include: [...new Set(include)] } };
  }

  /**
   * Helper: when a requestBody.stateFilter.include contains multiple values,
   * perform separate calls for each state and aggregate unique results.
   * This method normalizes string inputs ("ENABLED,PAUSED" or "ENABLED PAUSED"),
   * expands 'ALL' into all known states, and continues on per-state failures while
   * aggregating successful results.
   */
  async getAllPaginatedDataV3WithStateHandling(endpoint, requestBody = {}, customHeaders = {}) {
    // Normalize state filter first (accept strings or arrays, and 'ALL')
    requestBody = this.normalizeStateFilter(requestBody);

    if (requestBody.stateFilter && Array.isArray(requestBody.stateFilter.include) && requestBody.stateFilter.include.length > 1) {
      logger.warn(`stateFilter.include has multiple values (${requestBody.stateFilter.include.join(',')}); performing separate calls and aggregating results`);
      const results = [];
      const seenIds = new Set();
      let lastError = null;
      let successCount = 0;

      for (const state of requestBody.stateFilter.include) {
        const bodyForState = { ...requestBody, stateFilter: { include: [state] } };
        try {
          const data = await this.getAllPaginatedDataV3(endpoint, bodyForState, customHeaders);
          successCount++;
          for (const item of data) {
            const id = item.id || item.campaignId || item.adGroupId || item.keywordId || item.portfolioId || JSON.stringify(item);
            if (!seenIds.has(id)) {
              seenIds.add(id);
              results.push(item);
            }
          }
        } catch (error) {
          lastError = error;
          logger.warn(`Failed fetching state ${state} from ${endpoint}: ${error.message}`);
          // continue with other states
          continue;
        }
      }

      if (results.length === 0 && lastError) {
        // If all per-state attempts failed, surface the last error
        throw lastError;
      }

      logger.info(`Aggregated ${results.length} unique records from ${endpoint} across ${successCount} successful state(s)`);
      return results;
    }

    return await this.getAllPaginatedDataV3(endpoint, requestBody, customHeaders);
  }

  /**
   * Get all Sponsored Products campaigns using v3 API
   * Endpoint: POST /sp/campaigns/list
   */
  async getCampaigns(filters = {}) {
    logger.info('Fetching Sponsored Products campaigns (v3 API)...');
    
    const requestBody = {};
    // No default stateFilter — include only if caller provides one
    if (filters.stateFilter) {
      requestBody.stateFilter = filters.stateFilter;
    }

    // Add optional filters
    if (filters.campaignIdFilter) {
      requestBody.campaignIdFilter = filters.campaignIdFilter;
    }
    if (filters.nameFilter) {
      requestBody.nameFilter = filters.nameFilter;
    }

    // v3 API requires version-specific Content-Type and Accept headers
    const customHeaders = {
      'Content-Type': 'application/vnd.spcampaign.v3+json',
      'Accept': 'application/vnd.spcampaign.v3+json'
    };

    return await this.getAllPaginatedDataV3WithStateHandling('/sp/campaigns/list', requestBody, customHeaders);
  }

  /**
   * Get all Sponsored Products ad groups using v3 API
   * Endpoint: POST /sp/adGroups/list
   */
  async getAdGroups(filters = {}) {
    logger.info('Fetching Sponsored Products ad groups (v3 API)...');
    
    const requestBody = {};
    // No default stateFilter — include only if caller provides one
    if (filters.stateFilter) {
      requestBody.stateFilter = filters.stateFilter;
    }

    // Add optional filters
    if (filters.campaignIdFilter) {
      requestBody.campaignIdFilter = filters.campaignIdFilter;
    }
    if (filters.adGroupIdFilter) {
      requestBody.adGroupIdFilter = filters.adGroupIdFilter;
    }

    // v3 API requires version-specific Content-Type and Accept headers
    const customHeaders = {
      'Content-Type': 'application/vnd.spadgroup.v3+json',
      'Accept': 'application/vnd.spadgroup.v3+json'
    };

    return await this.getAllPaginatedDataV3WithStateHandling('/sp/adGroups/list', requestBody, customHeaders);
  }

  /**
   * Get all Sponsored Products keywords using v3 API
   * Endpoint: POST /sp/keywords/list
   */
  async getKeywords(filters = {}) {
    logger.info('Fetching Sponsored Products keywords (v3 API)...');
    
    const requestBody = {};
    // No default stateFilter — include only if caller provides one
    if (filters.stateFilter) {
      requestBody.stateFilter = filters.stateFilter;
    }

    // Add optional filters
    if (filters.campaignIdFilter) {
      requestBody.campaignIdFilter = filters.campaignIdFilter;
    }
    if (filters.adGroupIdFilter) {
      requestBody.adGroupIdFilter = filters.adGroupIdFilter;
    }
    if (filters.keywordIdFilter) {
      requestBody.keywordIdFilter = filters.keywordIdFilter;
    }

    // v3 API requires version-specific Content-Type and Accept headers
    const customHeaders = {
      'Content-Type': 'application/vnd.spkeyword.v3+json',
      'Accept': 'application/vnd.spkeyword.v3+json'
    };

    return await this.getAllPaginatedDataV3WithStateHandling('/sp/keywords/list', requestBody, customHeaders);
  }

  /**
   * Get all Sponsored Products product ads using v3 API
   * Endpoint: POST /sp/productAds/list
   */
  async getProductAds(filters = {}) {
    logger.info('Fetching Sponsored Products product ads (v3 API)...');
    
    const requestBody = {};
    // No default stateFilter — include only if caller provides one
    if (filters.stateFilter) {
      requestBody.stateFilter = filters.stateFilter;
    }

    // Add optional filters
    if (filters.campaignIdFilter) {
      requestBody.campaignIdFilter = filters.campaignIdFilter;
    }
    if (filters.adGroupIdFilter) {
      requestBody.adGroupIdFilter = filters.adGroupIdFilter;
    }

    // v3 API requires version-specific Content-Type and Accept headers
    const customHeaders = {
      'Content-Type': 'application/vnd.spproductad.v3+json',
      'Accept': 'application/vnd.spproductad.v3+json'
    };

    return await this.getAllPaginatedDataV3WithStateHandling('/sp/productAds/list', requestBody, customHeaders);
  }

  /**
   * Get all Sponsored Products negative keywords using v3 API
   * Endpoint: POST /sp/negativeKeywords/list
   */
  async getNegativeKeywords(filters = {}) {
    logger.info('Fetching Sponsored Products negative keywords (v3 API)...');
    
    const requestBody = {};
    // No default stateFilter — include only if caller provides one
    if (filters.stateFilter) {
      requestBody.stateFilter = filters.stateFilter;
    }

    if (filters.campaignIdFilter) {
      requestBody.campaignIdFilter = filters.campaignIdFilter;
    }
    if (filters.adGroupIdFilter) {
      requestBody.adGroupIdFilter = filters.adGroupIdFilter;
    }

    return await this.getAllPaginatedDataV3WithStateHandling('/sp/negativeKeywords/list', requestBody);
  }

  /**
   * Get all campaign negative keywords using v3 API
   * Endpoint: POST /sp/campaignNegativeKeywords/list
   */
  async getCampaignNegativeKeywords(filters = {}) {
    logger.info('Fetching Sponsored Products campaign negative keywords (v3 API)...');
    
    const requestBody = {};
    // No default stateFilter — include only if caller provides one
    if (filters.stateFilter) {
      requestBody.stateFilter = filters.stateFilter;
    }

    if (filters.campaignIdFilter) {
      requestBody.campaignIdFilter = filters.campaignIdFilter;
    }

    return await this.getAllPaginatedDataV3WithStateHandling('/sp/campaignNegativeKeywords/list', requestBody);
  }

  /**
   * Get Sponsored Products targets (product targeting) using v3 API
   * Endpoint: POST /sp/targets/list
   * 
   * Product targeting is DISTINCT from keyword targeting:
   * - Targets specific ASINs, categories, or brands
   * - Uses different matching types (ASIN-based, Category-based, Brand-based)
   * - Separate control from keyword-based targeting
   * 
   * FIX: Added custom headers 'Content-Type' and 'Accept' to resolve 415 error.
   * API requires 'application/vnd.sptargetingClause.v3+json' for this endpoint.
   */
  async getTargets(filters = {}) {
    logger.info('Fetching Sponsored Products targets - Product Targeting (v3 API)...');

    const requestBody = {};
    // No default stateFilter — include only if caller provides one
    if (filters.stateFilter) {
      requestBody.stateFilter = filters.stateFilter;
    }

    if (filters.campaignIdFilter) {
      requestBody.campaignIdFilter = filters.campaignIdFilter;
    }
    if (filters.adGroupIdFilter) {
      requestBody.adGroupIdFilter = filters.adGroupIdFilter;
    }

    // Product Targeting specific filters
    if (filters.targetingTypeFilter) {
      // Targeting types: asin_targeting, category_targeting, brand_targeting
      requestBody.targetingTypeFilter = filters.targetingTypeFilter;
    }

    // v3 API requires version-specific Content-Type and Accept headers for Targets
    const customHeaders = {
      'Content-Type': 'application/vnd.sptargetingClause.v3+json',
      'Accept': 'application/vnd.sptargetingClause.v3+json'
    };

    return await this.getAllPaginatedDataV3WithStateHandling('/sp/targets/list', requestBody, customHeaders);
  }

  /**
   * Get product targeting performance report
   * Distinct from keyword reports - focuses on ASIN/Category/Brand targeting
   * Endpoint: POST /reporting/reports
   */
  async getProductTargetingPerformanceData(reportDate) {
    logger.info(`Fetching product targeting performance data for ${reportDate}...`);

    const formattedDate = this.formatDateForAPI(reportDate);
    const columns = this.getDefaultMetrics('targets');
    
    const reportConfig = {
      name: `product_targeting_${reportDate}`,
      startDate: formattedDate,
      endDate: formattedDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: ['targeting'],
        columns: columns,
        reportTypeId: 'spTargeting',
        timeUnit: 'DAILY',
        format: 'GZIP_JSON'
      }
    };

    logger.debug('Product targeting report request config:', JSON.stringify(reportConfig, null, 2));

    const headers = {
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Accept': 'application/vnd.createasyncreportresponse.v3+json'
    };

    const response = await this.makeRequest('POST', '/reporting/reports', reportConfig, null, 3, 1000, headers);
    return response.reportId;
  }

  /**
   * Get Portfolios using v3 API
   * Endpoint: POST /portfolios/list
   */
  async getPortfolios(filters = {}) {
    logger.info('Fetching Portfolios (v3 API)...');
    
    const requestBody = {};
    // No default stateFilter — include only if caller provides one
    if (filters.stateFilter) {
      requestBody.stateFilter = filters.stateFilter;
    }

    if (filters.portfolioIdFilter) {
      requestBody.portfolioIdFilter = filters.portfolioIdFilter;
    }

    return await this.getAllPaginatedDataV3WithStateHandling('/portfolios/list', requestBody);
  }

  /**
   * Get Sponsored Brands campaigns using v4 API
   * Endpoint: POST /sb/v4/campaigns/list (no body — filters via query params)
   *
   * The SB v4 list endpoint uses POST but expects a null body ("Expected null").
   * All filtering and pagination are passed as query parameters.
   */
  async getSponsoredBrandsCampaigns(filters = {}) {
    logger.info('Fetching Sponsored Brands campaigns (v4 API) via POST /sb/v4/campaigns/list...');

    const params = this._buildSBCampaignsQueryParams(filters);
    const customHeaders = {
      'Accept': 'application/vnd.sbcampaignresource.v4+json'
    };

    const response = await this.makeRequest('POST', '/sb/v4/campaigns/list', null, params, 3, 100, customHeaders);

    if (!response) return { campaigns: [], nextToken: null };

    let campaigns = [];
    let nextToken = null;

    if (Array.isArray(response)) {
      campaigns = response;
    } else if (typeof response === 'object') {
      campaigns = response.campaigns || [];
      nextToken = response.nextToken || null;
    }

    return { campaigns, nextToken };
  }

  /**
   * Convenience: Get Sponsored Brands campaigns by array of IDs
   * @param {Array<string|number>} campaignIds
   */
  async getSBCampaignsByIds(campaignIds = []) {
    if (!Array.isArray(campaignIds) || campaignIds.length === 0) return [];
    const idFilter = campaignIds.join(',');
    const result = await this.getSponsoredBrandsCampaigns({ campaignIdFilter: idFilter });
    return result.campaigns || [];
  }

  /**
   * Page through all SB campaigns using nextToken pagination.
   * Endpoint: POST /sb/v4/campaigns/list (no body, query params only)
   */
  async getAllSBCampaigns(filters = {}) {
    const allCampaigns = [];
    let nextToken = null;
    const maxPages = 100;
    let page = 0;

    do {
      page++;
      if (page > maxPages) {
        logger.warn(`SB campaigns: reached max page limit (${maxPages}), stopping`);
        break;
      }

      const pageFilters = { ...filters, maxResults: 100 };
      if (nextToken) {
        pageFilters.nextToken = nextToken;
      }

      const result = await this.getSponsoredBrandsCampaigns(pageFilters);
      const campaigns = result.campaigns || [];
      nextToken = result.nextToken || null;

      allCampaigns.push(...campaigns);

      if (allCampaigns.length > 0) {
        logger.info(`Fetched ${allCampaigns.length} Sponsored Brands campaigns so far...`);
      }
    } while (nextToken);

    return allCampaigns;
  }

  /**
   * Build query params for POST /sb/v4/campaigns/list
   * SB v4 uses comma-delimited strings for filters passed as query parameters.
   * @private
   */
  _buildSBCampaignsQueryParams(filters = {}) {
    const params = {};

    if (filters.stateFilter) {
      if (typeof filters.stateFilter === 'object' && Array.isArray(filters.stateFilter.include)) {
        params.stateFilter = filters.stateFilter.include.map(s => String(s).trim().toLowerCase()).join(',');
      } else if (Array.isArray(filters.stateFilter)) {
        params.stateFilter = filters.stateFilter.map(s => String(s).trim().toLowerCase()).join(',');
      } else {
        params.stateFilter = String(filters.stateFilter).trim().toLowerCase();
      }
    } else {
      params.stateFilter = 'enabled,paused,archived';
    }

    if (filters.campaignIdFilter) {
      params.campaignIdFilter = Array.isArray(filters.campaignIdFilter)
        ? filters.campaignIdFilter.join(',')
        : filters.campaignIdFilter;
    }

    if (filters.name) {
      params.name = filters.name;
    } else if (filters.nameFilter) {
      params.name = filters.nameFilter;
    }

    if (filters.portfolioIdFilter) {
      params.portfolioIdFilter = Array.isArray(filters.portfolioIdFilter)
        ? filters.portfolioIdFilter.join(',')
        : filters.portfolioIdFilter;
    }

    if (filters.adFormatFilter) {
      params.adFormatFilter = filters.adFormatFilter;
    }

    if (Number.isInteger(filters.maxResults)) {
      params.maxResults = Math.min(Math.max(filters.maxResults, 10), 100);
    } else {
      params.maxResults = 100;
    }

    if (filters.nextToken) {
      params.nextToken = filters.nextToken;
    }

    return params;
  }

  /**
   * Convenience: Get Sponsored Brands campaigns filtered by a single state
   * state can be: 'enabled', 'paused', or 'archived'
   */
  async getSBCampaignsByState(state) {
    if (!state) return [];
    return await this.getSponsoredBrandsCampaigns({ stateFilter: state, count: 100 });
  }

  /**
   * Get Sponsored Display campaigns using v3 API
   * Endpoint: GET /sd/campaigns
   * 
   * FIX: Changed from POST to GET to resolve 405 error. 
   * SD v3 does not support POST /sd/campaigns/list. It uses GET query params like SB.
   */
  async getSponsoredDisplayCampaigns(filters = {}) {
    logger.info('Fetching Sponsored Display campaigns (v3 API)...');

    // Build query params for GET request
    const params = {};

    // Normalize stateFilter (expecting comma-separated string for GET)
    if (filters.stateFilter) {
      if (typeof filters.stateFilter === 'object' && Array.isArray(filters.stateFilter.include)) {
        params.stateFilter = filters.stateFilter.include.map(s => String(s).trim().toLowerCase()).join(',');
      } else if (Array.isArray(filters.stateFilter)) {
        params.stateFilter = filters.stateFilter.map(s => String(s).trim().toLowerCase()).join(',');
      } else {
        params.stateFilter = String(filters.stateFilter).trim().toLowerCase();
      }
    } else {
      // Default to common states
      params.stateFilter = 'enabled,paused,archived';
    }

    if (filters.campaignIdFilter) {
      params.campaignIdFilter = Array.isArray(filters.campaignIdFilter) ? filters.campaignIdFilter.join(',') : filters.campaignIdFilter;
    }

    if (filters.name) {
      params.name = filters.name;
    } else if (filters.nameFilter) {
      params.name = filters.nameFilter;
    }

    if (filters.portfolioIdFilter) {
      params.portfolioIdFilter = Array.isArray(filters.portfolioIdFilter) ? filters.portfolioIdFilter.join(',') : filters.portfolioIdFilter;
    }

    if (Number.isInteger(filters.startIndex)) {
      params.startIndex = filters.startIndex;
    }
    if (Number.isInteger(filters.count)) {
      params.count = filters.count;
    }

    // FIX: Use specific Accept header for SD v3
    const customHeaders = {
       'Accept': 'application/vnd.sdcampaign.v3+json, application/json'
    };

    // Perform GET request; normalize response (API may return { campaigns: [...] } or array)
    const result = await this.makeRequest('GET', '/sd/campaigns', null, params, 3, 100, customHeaders);
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.campaigns)) return result.campaigns;
    return [];
  }

  /**
   * Convenience: Page through all Sponsored Display campaigns using startIndex/count pagination
   * Helper method to aggregate results since GET does not support nextToken body pagination.
   */
  async getAllSponsoredDisplayCampaigns(filters = {}) {
    const allCampaigns = [];
    let startIndex = Number.isInteger(filters.startIndex) ? filters.startIndex : 0;
    const count = Number.isInteger(filters.count) ? filters.count : 100; // Max usually 100
    let hasMore = true;

    while (hasMore) {
      const pageFilters = { ...filters, startIndex, count };
      const campaigns = await this.getSponsoredDisplayCampaigns(pageFilters);
      
      if (!Array.isArray(campaigns)) break;

      allCampaigns.push(...campaigns);

      if (campaigns.length < count) {
        hasMore = false;
      } else {
        startIndex += count;
      }

      logger.info(`Fetched ${allCampaigns.length} Sponsored Display campaigns so far...`);
    }

    return allCampaigns;
  }

  /**
   * Get Sponsored Brands ad groups using v4 API
   * Endpoint: POST /sb/v4/adGroups/list (query params, null body)
   * Reference: https://advertising.amazon.com/API/docs/en-us/sponsored-brands/3-0/openapi/prod
   */
  async getSponsoredBrandsAdGroups(filters = {}) {
    logger.info('Fetching Sponsored Brands ad groups (v4 API) via POST /sb/v4/adGroups/list...');

    const params = this._buildSBAdGroupsQueryParams(filters);
    const customHeaders = {
      'Accept': 'application/vnd.sbadgroup.v4+json'
    };

    const response = await this.makeRequest('POST', '/sb/v4/adGroups/list', null, params, 3, 100, customHeaders);

    if (!response) return { adGroups: [], nextToken: null };

    let adGroups = [];
    let nextToken = null;

    if (Array.isArray(response)) {
      adGroups = response;
    } else if (typeof response === 'object') {
      adGroups = response.adGroups || response.adGroupList || [];
      nextToken = response.nextToken || null;
    }

    return { adGroups, nextToken };
  }

  _buildSBAdGroupsQueryParams(filters = {}) {
    const params = {};

    if (filters.stateFilter) {
      if (typeof filters.stateFilter === 'object' && Array.isArray(filters.stateFilter.include)) {
        params.stateFilter = filters.stateFilter.include.map(s => String(s).trim().toLowerCase()).join(',');
      } else if (Array.isArray(filters.stateFilter)) {
        params.stateFilter = filters.stateFilter.map(s => String(s).trim().toLowerCase()).join(',');
      } else {
        params.stateFilter = String(filters.stateFilter).trim().toLowerCase();
      }
    } else {
      params.stateFilter = 'enabled,paused,archived';
    }

    if (filters.campaignIdFilter) {
      params.campaignIdFilter = Array.isArray(filters.campaignIdFilter)
        ? filters.campaignIdFilter.join(',')
        : String(filters.campaignIdFilter);
    }

    if (Number.isInteger(filters.maxResults)) {
      params.maxResults = Math.min(Math.max(filters.maxResults, 10), 100);
    } else {
      params.maxResults = 100;
    }

    if (filters.nextToken) {
      params.nextToken = filters.nextToken;
    }

    return params;
  }

  /**
   * Page through all SB ad groups using nextToken pagination.
   */
  async getAllSponsoredBrandsAdGroups(filters = {}) {
    const allAdGroups = [];
    let nextToken = null;
    const maxPages = 100;
    let page = 0;

    do {
      page++;
      if (page > maxPages) {
        logger.warn(`SB ad groups: reached max page limit (${maxPages}), stopping`);
        break;
      }

      const pageFilters = { ...filters, maxResults: 100 };
      if (nextToken) {
        pageFilters.nextToken = nextToken;
      }

      const result = await this.getSponsoredBrandsAdGroups(pageFilters);
      const adGroups = result.adGroups || [];
      nextToken = result.nextToken || null;

      allAdGroups.push(...adGroups);

      if (allAdGroups.length > 0 && allAdGroups.length % 500 === 0) {
        logger.info(`Fetched ${allAdGroups.length} Sponsored Brands ad groups so far...`);
      }
    } while (nextToken);

    return allAdGroups;
  }

  /**
   * Get Sponsored Display ad groups using v3 API
   * Endpoint: GET /sd/adGroups
   * Reference: https://advertising.amazon.com/API/docs/en-us/sponsored-display/3-0/openapi
   */
  async getSponsoredDisplayAdGroups(filters = {}) {
    logger.info('Fetching Sponsored Display ad groups (v3 API)...');

    const params = {};

    if (filters.stateFilter) {
      if (typeof filters.stateFilter === 'object' && Array.isArray(filters.stateFilter.include)) {
        params.stateFilter = filters.stateFilter.include.map(s => String(s).trim().toLowerCase()).join(',');
      } else if (Array.isArray(filters.stateFilter)) {
        params.stateFilter = filters.stateFilter.map(s => String(s).trim().toLowerCase()).join(',');
      } else {
        params.stateFilter = String(filters.stateFilter).trim().toLowerCase();
      }
    } else {
      params.stateFilter = 'enabled,paused,archived';
    }

    if (filters.campaignIdFilter) {
      params.campaignIdFilter = Array.isArray(filters.campaignIdFilter) ? filters.campaignIdFilter.join(',') : String(filters.campaignIdFilter);
    }

    if (Number.isInteger(filters.startIndex)) {
      params.startIndex = filters.startIndex;
    }
    if (Number.isInteger(filters.count)) {
      params.count = filters.count;
    }

    const customHeaders = {
      'Accept': 'application/vnd.sdadgroup.v3+json, application/json'
    };

    const result = await this.makeRequest('GET', '/sd/adGroups', null, params, 3, 100, customHeaders);
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.adGroups)) return result.adGroups;
    if (result && Array.isArray(result.adGroupList)) return result.adGroupList;
    return [];
  }

  /**
   * Page through all Sponsored Display ad groups using startIndex/count pagination.
   */
  async getAllSponsoredDisplayAdGroups(filters = {}) {
    const allAdGroups = [];
    let startIndex = Number.isInteger(filters.startIndex) ? filters.startIndex : 0;
    const count = Number.isInteger(filters.count) ? filters.count : 100;
    let hasMore = true;

    while (hasMore) {
      const pageFilters = { ...filters, startIndex, count };
      const adGroups = await this.getSponsoredDisplayAdGroups(pageFilters);

      if (!Array.isArray(adGroups)) break;

      allAdGroups.push(...adGroups);

      if (adGroups.length < count) {
        hasMore = false;
      } else {
        startIndex += count;
      }

      if (allAdGroups.length > 0 && allAdGroups.length % 500 === 0) {
        logger.info(`Fetched ${allAdGroups.length} Sponsored Display ad groups so far...`);
      }
    }

    return allAdGroups;
  }

  /**
   * Request a performance report using v3 API
   * According to: https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/report-types/overview
   */
  async requestReport(reportType, reportDate, metrics) {
    logger.info(`Requesting ${reportType} report for ${reportDate} using v3 API...`);

    const metricsArray = metrics || this.getDefaultMetrics(reportType);
    
    // Map report types to API reportTypeId values
    // Note: spAdGroups and spKeywords are NOT available for all accounts
    // Use spCampaigns with groupBy: adGroup for ad groups
    // Use spTargeting with groupBy: targeting for keywords
    const reportTypeMap = {
      'campaigns': 'spCampaigns',
      'adGroups': 'spCampaigns',        // Use spCampaigns with groupBy: adGroup
      'keywords': 'spTargeting',         // Use spTargeting for keyword data
      'productAds': 'spAdvertisedProduct',
      'searchTerms': 'spSearchTerm',
      'purchasedProducts': 'spPurchasedProduct'
    };

    // Convert YYYYMMDD format to YYYY-MM-DD format for API
    const formattedDate = this.formatDateForAPI(reportDate);

    // GroupBy values for each report type
    const groupByMap = {
      'campaigns': ['campaign'],
      'adGroups': ['adGroup'],           // groupBy adGroup with spCampaigns
      'keywords': ['targeting'],         // groupBy targeting with spTargeting
      'productAds': ['advertiser'],
      'searchTerms': ['searchTerm'],
      'purchasedProducts': ['asin']
    };

    // v3 API format - dates go at top level, not inside configuration
    const reportConfig = {
      name: `${reportType}_${reportDate}`,
      startDate: formattedDate,  // Dates are at top level in YYYY-MM-DD format
      endDate: formattedDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: groupByMap[reportType],
        columns: metricsArray,
        reportTypeId: reportTypeMap[reportType],
        timeUnit: 'DAILY',
        format: 'GZIP_JSON'
      }
    };

    logger.debug('v3 Report request config:', JSON.stringify(reportConfig, null, 2));

    // Use the correct Content-Type header for v3 report creation
    const headers = {
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Accept': 'application/vnd.createasyncreportresponse.v3+json'
    };

    const response = await this.makeRequest('POST', '/reporting/reports', reportConfig, null, 3, 1000, headers);
    return response.reportId;
  }

  /**
   * Request a search term report using v3 API
   * Used for negative keyword analysis and search term harvesting
   */
  async requestSearchTermReport(reportDate) {
    logger.info(`Requesting search term report for ${reportDate}...`);
    return await this.requestReport('searchTerms', reportDate);
  }

  /**
   * Get search term performance data
   */
  async getSearchTermPerformanceData(reportDate) {
    logger.info(`Fetching search term performance data for ${reportDate}...`);

    const reportId = await this.requestSearchTermReport(reportDate);
    const reportData = await this.waitAndDownloadReport(reportId);

    return reportData;
  }

  /**
   * Convert date from YYYYMMDD format to YYYY-MM-DD format for API
   */
  formatDateForAPI(apiDate) {
    if (apiDate.includes('-')) return apiDate; // Already formatted
    // Convert 20251022 to 2025-10-22
    return `${apiDate.substr(0, 4)}-${apiDate.substr(4, 2)}-${apiDate.substr(6, 2)}`;
  }

  /**
   * Get report status using v3 API
   */
  async getReportStatus(reportId) {
    const headers = {
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Accept': 'application/vnd.createasyncreportresponse.v3+json'
    };
    return await this.makeRequest('GET', `/reporting/reports/${reportId}`, null, null, 3, 1000, headers);
  }

  /**
   * Download report data from v3 API
   * v3 API returns GZIP compressed JSON data
   */
  async downloadReport(reportUrl) {
    try {
      const zlib = require('zlib');
      const { promisify } = require('util');
      const gunzip = promisify(zlib.gunzip);

      logger.info(`Downloading report from: ${reportUrl}`);
      
      // Download the gzipped report file
      const response = await axios.get(reportUrl, {
        responseType: 'arraybuffer',  // Get as buffer for decompression
        timeout: 60000  // 60 second timeout for large files
      });

      logger.debug(`Downloaded ${response.data.length} bytes (compressed)`);

      // Decompress gzip data
      const decompressed = await gunzip(response.data);
      logger.debug(`Decompressed to ${decompressed.length} bytes`);
      
      // Parse JSON
      const jsonData = JSON.parse(decompressed.toString('utf-8'));
      
      logger.info(`Report downloaded successfully, records: ${Array.isArray(jsonData) ? jsonData.length : Object.keys(jsonData).length}`);
      return jsonData;
    } catch (error) {
      logger.error('Error downloading report:', {
        message: error.message,
        url: reportUrl,
        stack: error.stack
      });
      throw new Error(`Failed to download/decompress report: ${error.message}`);
    }
  }

  /**
   * Get default metrics for a report type
   * Updated for Amazon Ads API v3 with validated column names
   * IMPORTANT: Each report type and groupBy combination has specific allowed columns
   */
  getDefaultMetrics(reportType) {
    const metricsMap = {
      // spCampaigns with groupBy: ['campaign']
      // Has campaign-level columns
      campaigns: [
        'date',
        'campaignId',
        'campaignName',
        'campaignStatus',
        'campaignBudgetAmount',
        'campaignBudgetType',
        'campaignBiddingStrategy',
        'impressions',
        'clicks',
        'cost',
        'costPerClick',
        'clickThroughRate',
        'purchases1d',
        'purchases7d',
        'purchases14d',
        'purchases30d',
        'sales1d',
        'sales7d',
        'sales14d',
        'sales30d',
        'unitsSoldClicks1d',
        'unitsSoldClicks7d',
        'unitsSoldClicks14d',
        'unitsSoldClicks30d'
      ],
      // spCampaigns with groupBy: ['adGroup']
      // Has ad group columns, also includes some campaign columns
      adGroups: [
        'date',
        'campaignBiddingStrategy',
        'adGroupId',
        'adGroupName',
        'adStatus',
        'impressions',
        'clicks',
        'clickThroughRate',
        'cost',
        'spend',
        'costPerClick',
        'purchases1d',
        'purchases7d',
        'purchases14d',
        'purchases30d',
        'purchasesSameSku1d',
        'purchasesSameSku7d',
        'purchasesSameSku14d',
        'purchasesSameSku30d',
        'sales1d',
        'sales7d',
        'sales14d',
        'sales30d',
        'attributedSalesSameSku1d',
        'attributedSalesSameSku7d',
        'attributedSalesSameSku14d',
        'attributedSalesSameSku30d',
        'unitsSoldClicks1d',
        'unitsSoldClicks7d',
        'unitsSoldClicks14d',
        'unitsSoldClicks30d',
        'unitsSoldSameSku1d',
        'unitsSoldSameSku7d',
        'unitsSoldSameSku14d',
        'unitsSoldSameSku30d',
        'roasClicks14d',
        'acosClicks14d',
        'addToList',
        'retailer'
      ],
      // spTargeting with groupBy: ['targeting'] - used for keyword data
      // Uses 'keyword' not 'keywordText', 'adKeywordStatus' not 'keywordStatus'
      keywords: [
        'date',
        'campaignId',
        'campaignName',
        'campaignStatus',
        'campaignBudgetAmount',
        'campaignBudgetCurrencyCode',
        'campaignBudgetType',
        'adGroupId',
        'adGroupName',
        'keywordId',
        'keyword',
        'matchType',
        'keywordBid',
        'adKeywordStatus',
        'targeting',
        'keywordType',
        'impressions',
        'clicks',
        'clickThroughRate',
        'cost',
        'costPerClick',
        'topOfSearchImpressionShare',
        'purchases1d',
        'purchases7d',
        'purchases14d',
        'purchases30d',
        'purchasesSameSku1d',
        'purchasesSameSku7d',
        'purchasesSameSku14d',
        'purchasesSameSku30d',
        'sales1d',
        'sales7d',
        'sales14d',
        'sales30d',
        'attributedSalesSameSku1d',
        'attributedSalesSameSku7d',
        'attributedSalesSameSku14d',
        'attributedSalesSameSku30d',
        'salesOtherSku7d',
        'unitsSoldClicks1d',
        'unitsSoldClicks7d',
        'unitsSoldClicks14d',
        'unitsSoldClicks30d',
        'unitsSoldSameSku1d',
        'unitsSoldSameSku7d',
        'unitsSoldSameSku14d',
        'unitsSoldSameSku30d',
        'unitsSoldOtherSku7d',
        'roasClicks7d',
        'roasClicks14d',
        'acosClicks7d',
        'acosClicks14d'
      ],
      // spAdvertisedProduct with groupBy: ['advertiser']
      productAds: [
        'date',
        'campaignId',
        'campaignName',
        'adGroupId',
        'adGroupName',
        'adId',
        'advertisedAsin',
        'advertisedSku',
        'impressions',
        'clicks',
        'cost',
        'spend',
        'costPerClick',
        'clickThroughRate',
        'purchases1d',
        'purchases7d',
        'purchases14d',
        'purchases30d',
        'sales1d',
        'sales7d',
        'sales14d',
        'sales30d',
        'unitsSoldClicks1d',
        'unitsSoldClicks7d',
        'unitsSoldClicks14d',
        'unitsSoldClicks30d',
        'acosClicks7d',
        'roasClicks7d'
      ],
      // spTargeting with groupBy: ['targeting']
      targets: [
        'date',
        'campaignId',
        'campaignName',
        'adGroupId',
        'adGroupName',
        'targeting',
        'impressions',
        'clicks',
        'cost',
        'costPerClick',
        'clickThroughRate',
        'purchases1d',
        'purchases7d',
        'purchases14d',
        'purchases30d',
        'sales1d',
        'sales7d',
        'sales14d',
        'sales30d',
        'unitsSoldClicks1d',
        'unitsSoldClicks7d',
        'unitsSoldClicks14d',
        'unitsSoldClicks30d'
      ],
      // spSearchTerm with groupBy: ['searchTerm']
      searchTerms: [
        'date',
        'campaignId',
        'campaignName',
        'adGroupId',
        'adGroupName',
        'keywordId',
        'keyword',
        'matchType',
        'searchTerm',
        'impressions',
        'clicks',
        'cost',
        'purchases1d',
        'purchases7d',
        'purchases14d',
        'purchases30d',
        'sales1d',
        'sales7d',
        'sales14d',
        'sales30d',
        'unitsSoldClicks1d',
        'unitsSoldClicks7d',
        'unitsSoldClicks14d',
        'unitsSoldClicks30d'
      ],
      // spPurchasedProduct with groupBy: ['asin']
      purchasedProducts: [
        'date',
        'campaignId',
        'campaignName',
        'adGroupId',
        'adGroupName',
        'advertisedAsin',
        'advertisedSku',
        'purchasedAsin',
        'purchases1d',
        'purchases7d',
        'purchases14d',
        'purchases30d',
        'sales1d',
        'sales7d',
        'sales14d',
        'sales30d',
        'unitsSoldClicks1d',
        'unitsSoldClicks7d',
        'unitsSoldClicks14d',
        'unitsSoldClicks30d'
      ]
    };

    return metricsMap[reportType] || [];
  }

  /**
   * Get default metrics for Sponsored Display reports (SD)
   * Note: SD has different column names than SP and SB, includes vCPM
   */
  getDefaultMetricsForSponsoredDisplay() {
    return [
      'date',
      'campaignId',
      'campaignName',
      'campaignStatus',
      'impressions',
      'clicks',
      'clickThroughRate',
      'spend',
      'cost',
      'costPerClick',
      'vCPM',
      'purchases1d',
      'purchases7d',
      'purchases14d',
      'purchases30d',
      'sales1d',
      'sales7d',
      'sales14d',
      'sales30d',
      'unitsSoldClicks1d',
      'unitsSoldClicks7d',
      'unitsSoldClicks14d',
      'unitsSoldClicks30d',
      'roasClicks7d',
      'roasClicks14d',
      'acosClicks7d',
      'acosClicks14d'
    ];
  }

  /**
   * Get default metrics for Sponsored Brands reports (SB)
   */
  getDefaultMetricsForSponsoredBrands() {
    return [
      'date',
      'campaignId',
      'campaignName',
      'campaignStatus',
      'campaignBudgetAmount',
      'impressions',
      'clicks',
      'clickThroughRate',
      'cost',
      'spend',
      'costPerClick',
      'purchases1d',
      'purchases7d',
      'purchases14d',
      'purchases30d',
      'purchasesSameSku1d',
      'purchasesSameSku7d',
      'purchasesSameSku14d',
      'purchasesSameSku30d',
      'sales1d',
      'sales7d',
      'sales14d',
      'sales30d',
      'attributedSalesSameSku1d',
      'attributedSalesSameSku7d',
      'attributedSalesSameSku14d',
      'attributedSalesSameSku30d',
      'unitsSoldClicks1d',
      'unitsSoldClicks7d',
      'unitsSoldClicks14d',
      'unitsSoldClicks30d',
      'roasClicks7d',
      'roasClicks14d',
      'acosClicks7d',
      'acosClicks14d'
    ];
  }

  /**
   * Wait for report to be ready and download it (v3 API)
   * v3 API statuses: PENDING, PROCESSING, COMPLETED, FAILED
   * Similar to Python sample's status checking loop
   */
  async waitAndDownloadReport(reportId, maxAttempts = 60, delayMs = 30000) {
    logger.info(`Starting report status check for ${reportId}...`);
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const statusResponse = await this.getReportStatus(reportId);

        logger.info(`Report ${reportId} status: ${statusResponse.status} (attempt ${attempt + 1}/${maxAttempts})`);

        // Handle all possible status values
        if (statusResponse.status === 'COMPLETED' || statusResponse.status === 'SUCCESS') {
          logger.info(`Report ${reportId} is ready, downloading...`);
          
          // Get download URL (v3 uses 'url', v2 uses 'location')
          const downloadUrl = statusResponse.url || statusResponse.location;
          
          if (!downloadUrl) {
            throw new Error('Report completed but no download URL provided');
          }
          
          return await this.downloadReport(downloadUrl);
        } else if (statusResponse.status === 'FAILED' || statusResponse.status === 'FAILURE') {
          const errorDetail = statusResponse.failureReason || statusResponse.statusDetails || 'Unknown error';
          throw new Error(`Report ${reportId} generation failed: ${errorDetail}`);
        } else if (['IN_PROGRESS', 'PROCESSING', 'PENDING'].includes(statusResponse.status)) {
          // Use exponential backoff for longer waits
          const waitTime = Math.min(delayMs * Math.pow(1.2, Math.floor(attempt / 5)), 120000); // Max 2 minutes
          logger.info(`Report generation in progress, waiting ${waitTime / 1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          logger.warn(`Unknown report status: ${statusResponse.status}`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      } catch (error) {
        if (error.message.includes('generation failed')) {
          throw error; // Don't retry if report generation explicitly failed
        }
        logger.warn(`Error checking report status (attempt ${attempt + 1}/${maxAttempts}):`, error.message);
        
        if (attempt === maxAttempts - 1) {
          throw error; // Throw on last attempt
        }
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw new Error(`Report ${reportId} timed out after ${maxAttempts} attempts (${(maxAttempts * delayMs) / 60000} minutes)`);
  }

  /**
   * Request keyword performance report using v3 API
   * Using spTargeting report type with groupBy: ['targeting']
   * Note: spKeywords is NOT available for all accounts, so we use spTargeting
   */
  async requestKeywordReport(reportDate) {
    logger.info(`Requesting keyword performance report for ${reportDate}...`);
    
    const formattedDate = this.formatDateForAPI(reportDate);
    
    // Use comprehensive metrics from getDefaultMetrics
    const columns = this.getDefaultMetrics('keywords');
    
    // v3 API uses spTargeting report type with groupBy: ['targeting'] for keyword data
    const reportConfig = {
      name: `keywords_${reportDate}`,
      startDate: formattedDate,
      endDate: formattedDate,
      configuration: {
        adProduct: 'SPONSORED_PRODUCTS',
        groupBy: ['targeting'],
        columns: columns,
        reportTypeId: 'spTargeting',
        timeUnit: 'DAILY',
        format: 'GZIP_JSON'
      }
    };

    logger.debug('Keyword report request config:', JSON.stringify(reportConfig, null, 2));

    // Use the correct Content-Type header for v3 report creation
    const headers = {
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Accept': 'application/vnd.createasyncreportresponse.v3+json'
    };

    const response = await this.makeRequest('POST', '/reporting/reports', reportConfig, null, 3, 1000, headers);
    return response.reportId;
  }

  /**
   * Get keyword performance data
   */
  async getKeywordPerformanceData(reportDate) {
    logger.info(`Fetching keyword performance data for ${reportDate}...`);

    const reportId = await this.requestKeywordReport(reportDate);
    const reportData = await this.waitAndDownloadReport(reportId);

    return reportData;
  }

  /**
   * Get performance data for a date range using v3 API
   * v3 API supports date ranges natively
   */
  async getPerformanceData(reportType, startDate, endDate) {
    logger.info(`Fetching ${reportType} performance data for ${startDate} using v3 API...`);

    // For keywords, use the specific keyword report endpoint
    if (reportType === 'keywords') {
      return await this.getKeywordPerformanceData(startDate);
    }

    // For other report types, use the standard v3 format
    const reportId = await this.requestReport(reportType, startDate);
    const reportData = await this.waitAndDownloadReport(reportId);

    return reportData;
  }

  /**
   * Get default metrics for Sponsored Brands (SB) campaign report.
   *
   * IMPORTANT: SB uses different column names from SP.
   * SP has time-windowed columns (purchases1d, purchases7d, sales14d, etc.).
   * SB has aggregated columns with NO time suffix – 14-day attribution by default:
   *   purchases, purchasesClicks, sales, salesClicks, unitsSold, unitsSoldClicks
   *
   * Official reference (v3 Reporting – Campaign report, Sponsored Brands base metrics):
   * https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/report-types/campaign
   */
  getDefaultMetricsForSBCampaigns() {
    return [
      'date',
      'campaignId',
      'campaignName',
      'campaignStatus',
      'campaignBudgetAmount',
      'campaignBudgetType',
      'impressions',
      'clicks',
      'cost',
      'purchases',
      'purchasesClicks',
      'purchasesPromoted',
      'sales',
      'salesClicks',
      'salesPromoted',
      'unitsSold',
      'unitsSoldClicks',
      'newToBrandPurchases',
      'newToBrandSales',
      'newToBrandUnitsSold',
      'detailPageViews',
      'detailPageViewsClicks',
      'viewClickThroughRate'
    ];
  }

  /**
   * Request a Sponsored Brands campaign performance report using v3 Reporting API
   * Populates campaign_performance for SB campaigns (campaign_type = 'SB').
   * Uses same reporting v3 endpoint as SP; adProduct SPONSORED_BRANDS and reportTypeId sbCampaigns.
   */
  async requestSBCampaignReport(reportDate) {
    logger.info(`Requesting Sponsored Brands campaign performance report for ${reportDate}...`);

    const formattedDate = this.formatDateForAPI(reportDate);
    const columns = this.getDefaultMetricsForSBCampaigns();

    const reportConfig = {
      name: `sbCampaigns_${reportDate}`,
      startDate: formattedDate,
      endDate: formattedDate,
      configuration: {
        adProduct: 'SPONSORED_BRANDS',
        groupBy: ['campaign'],
        columns,
        reportTypeId: 'sbCampaigns',
        timeUnit: 'DAILY',
        format: 'GZIP_JSON'
      }
    };

    const headers = {
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Accept': 'application/vnd.createasyncreportresponse.v3+json'
    };

    const response = await this.makeRequest('POST', '/reporting/reports', reportConfig, null, 3, 1000, headers);
    return response.reportId;
  }

  /**
   * Get Sponsored Brands campaign performance data for a report date
   * Returns array of records suitable for campaign_performance table (campaign_id, report_date, impressions, clicks, cost, attributed_conversions_*, attributed_sales_*).
   */
  async getSBCampaignPerformanceData(reportDate) {
    logger.info(`Fetching Sponsored Brands campaign performance data for ${reportDate}...`);

    const reportId = await this.requestSBCampaignReport(reportDate);
    const reportData = await this.waitAndDownloadReport(reportId);

    return reportData;
  }

  /**
   * Default metrics for Sponsored Display campaign report (v3 Reporting API).
   * SD uses purchasesClicks/salesClicks (not purchases1d/7d/14d/30d, sales1d/7d/14d/30d).
   * Only columns in the API's allowed list may be requested.
   */
  getDefaultMetricsForSDCampaigns() {
    return [
      'date',
      'campaignId',
      'campaignName',
      'impressions',
      'clicks',
      'cost',
      'purchasesClicks',
      'salesClicks'
    ];
  }

  /**
   * Request a Sponsored Display campaign performance report using v3 Reporting API.
   * Populates campaign_performance for SD campaigns (campaign_type = 'SD').
   * adProduct SPONSORED_DISPLAY, reportTypeId sdCampaigns.
   */
  async requestSDCampaignReport(reportDate) {
    logger.info(`Requesting Sponsored Display campaign performance report for ${reportDate}...`);

    const formattedDate = this.formatDateForAPI(reportDate);
    const columns = this.getDefaultMetricsForSDCampaigns();

    const reportConfig = {
      name: `sdCampaigns_${reportDate}`,
      startDate: formattedDate,
      endDate: formattedDate,
      configuration: {
        adProduct: 'SPONSORED_DISPLAY',
        groupBy: ['campaign'],
        columns,
        reportTypeId: 'sdCampaigns',
        timeUnit: 'DAILY',
        format: 'GZIP_JSON'
      }
    };

    const headers = {
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Accept': 'application/vnd.createasyncreportresponse.v3+json'
    };

    const response = await this.makeRequest('POST', '/reporting/reports', reportConfig, null, 3, 1000, headers);
    return response.reportId;
  }

  /**
   * Get Sponsored Display campaign performance data for a report date.
   * Returns raw report data (array or array-of-arrays); use normalizeReportRows in dataSync before mapping.
   */
  async getSDCampaignPerformanceData(reportDate) {
    logger.info(`Fetching Sponsored Display campaign performance data for ${reportDate}...`);

    const reportId = await this.requestSDCampaignReport(reportDate);
    const reportData = await this.waitAndDownloadReport(reportId);

    return reportData;
  }

  /**
   * Default metrics for Sponsored Brands ad group report (v3 Reporting API).
   * sbCampaigns with groupBy: ['adGroup'] returns adGroupId, campaignId, and SB metric names.
   */
  getDefaultMetricsForSBAdGroups() {
    return [
      'date',
      'campaignId',
      'campaignName',
      'adGroupId',
      'adGroupName',
      'impressions',
      'clicks',
      'cost',
      'purchases',
      'purchasesClicks',
      'sales',
      'salesClicks'
    ];
  }

  /**
   * Request a Sponsored Brands ad group performance report (v3 Reporting API).
   * adProduct SPONSORED_BRANDS, reportTypeId sbCampaigns, groupBy: ['adGroup'].
   */
  async requestSBAdGroupReport(reportDate) {
    logger.info(`Requesting Sponsored Brands ad group performance report for ${reportDate}...`);

    const formattedDate = this.formatDateForAPI(reportDate);
    const columns = this.getDefaultMetricsForSBAdGroups();

    const reportConfig = {
      name: `sbAdGroups_${reportDate}`,
      startDate: formattedDate,
      endDate: formattedDate,
      configuration: {
        adProduct: 'SPONSORED_BRANDS',
        groupBy: ['adGroup'],
        columns,
        reportTypeId: 'sbCampaigns',
        timeUnit: 'DAILY',
        format: 'GZIP_JSON'
      }
    };

    const headers = {
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Accept': 'application/vnd.createasyncreportresponse.v3+json'
    };

    const response = await this.makeRequest('POST', '/reporting/reports', reportConfig, null, 3, 1000, headers);
    return response.reportId;
  }

  /**
   * Get Sponsored Brands ad group performance data for a report date.
   */
  async getSBAdGroupPerformanceData(reportDate) {
    logger.info(`Fetching Sponsored Brands ad group performance data for ${reportDate}...`);

    const reportId = await this.requestSBAdGroupReport(reportDate);
    const reportData = await this.waitAndDownloadReport(reportId);

    return reportData;
  }

  /**
   * Default metrics for Sponsored Display ad group report (v3 Reporting API).
   * sdCampaigns with groupBy: ['adGroup'] returns adGroupId, campaignId, and SD metric names.
   */
  getDefaultMetricsForSDAdGroups() {
    return [
      'date',
      'campaignId',
      'campaignName',
      'adGroupId',
      'adGroupName',
      'impressions',
      'clicks',
      'cost',
      'purchasesClicks',
      'salesClicks'
    ];
  }

  /**
   * Request a Sponsored Display ad group performance report (v3 Reporting API).
   * adProduct SPONSORED_DISPLAY, reportTypeId sdCampaigns, groupBy: ['adGroup'].
   */
  async requestSDAdGroupReport(reportDate) {
    logger.info(`Requesting Sponsored Display ad group performance report for ${reportDate}...`);

    const formattedDate = this.formatDateForAPI(reportDate);
    const columns = this.getDefaultMetricsForSDAdGroups();

    const reportConfig = {
      name: `sdAdGroups_${reportDate}`,
      startDate: formattedDate,
      endDate: formattedDate,
      configuration: {
        adProduct: 'SPONSORED_DISPLAY',
        groupBy: ['adGroup'],
        columns,
        reportTypeId: 'sdCampaigns',
        timeUnit: 'DAILY',
        format: 'GZIP_JSON'
      }
    };

    const headers = {
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Accept': 'application/vnd.createasyncreportresponse.v3+json'
    };

    const response = await this.makeRequest('POST', '/reporting/reports', reportConfig, null, 3, 1000, headers);
    return response.reportId;
  }

  /**
   * Get Sponsored Display ad group performance data for a report date.
   */
  async getSDAdGroupPerformanceData(reportDate) {
    logger.info(`Fetching Sponsored Display ad group performance data for ${reportDate}...`);

    const reportId = await this.requestSDAdGroupReport(reportDate);
    const reportData = await this.waitAndDownloadReport(reportId);

    return reportData;
  }
}

module.exports = AmazonAdsClient;