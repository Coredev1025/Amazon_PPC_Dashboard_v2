'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/contexts/ToastContext';
import {
  Play,
  Pause,
  Filter,
  Download,
  RefreshCw,
  ChevronRight,
  Package,
  AlertTriangle,
  FileDown,
  FileText,
  Target,
  Settings,
  ChevronDown,
} from 'lucide-react';
import SmartGrid from '@/components/SmartGrid';
import HierarchicalTabs, { type TabType } from '@/components/HierarchicalTabs';
import DateRangePicker, { type DateRange } from '@/components/DateRangePicker';
import MasterPerformanceChart, { type EventAnnotation } from '@/components/MasterPerformanceChart';

function getChartDateRange(dateRange: DateRange): { start: Date; end: Date } | null {
  if (dateRange.startDate && dateRange.endDate) {
    return { start: new Date(dateRange.startDate), end: new Date(dateRange.endDate) };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setHours(23, 59, 59, 999);
  let start = new Date(today);
  const type = dateRange.type;
  if (type === 'last_7_days') start.setDate(start.getDate() - 6);
  else if (type === 'last_14_days') start.setDate(start.getDate() - 13);
  else if (type === 'last_30_days') start.setDate(start.getDate() - 29);
  else if (type === 'today') { /* start = today */ }
  else if (type === 'yesterday') { start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); }
  else if (type === 'this_week') start.setDate(today.getDate() - today.getDay());
  else if (type === 'last_week') { start.setDate(today.getDate() - today.getDay() - 7); end.setDate(today.getDate() - today.getDay() - 1); }
  else if (type === 'this_month') start = new Date(today.getFullYear(), today.getMonth(), 1);
  else if (type === 'last_month') { start = new Date(today.getFullYear(), today.getMonth() - 1, 1); end.setTime(new Date(today.getFullYear(), today.getMonth(), 0).getTime()); end.setHours(23, 59, 59, 999); }
  else if (type === 'year_to_date' || type === 'this_year') start = new Date(today.getFullYear(), 0, 1);
  else if (type === 'lifetime') start = new Date(2020, 0, 1);
  return { start, end };
}

function generateDateRange(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const endCopy = new Date(end);
  endCopy.setHours(23, 59, 59, 999);
  while (cur <= endCopy) {
    dates.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}
import InventoryBadge from '@/components/InventoryBadge';
import {
  fetchCampaigns,
  fetchPortfolios,
  fetchAdGroups,
  fetchAds,
  fetchKeywords,
  fetchProductTargeting,
  fetchSearchTerms,
  fetchPlacements,
  applyCampaignAction,
  addSearchTermAsKeyword,
  addSearchTermAsNegative,
  getInventoryStatus,
  fetchTrends,
  addCampaignToPortfolio,
  bulkAddCampaignsToPortfolio,
  fetchEventAnnotations,
  type Campaign,
  type SearchTerm,
  type Portfolio,
} from '@/utils/api';
import {
  formatCurrency,
  formatAcos,
  formatRoas,
  formatNumber,
  formatPercentage,
  cn,
  getStatusBadge,
} from '@/utils/helpers';

/** Preserve main content scroll position across dropdown/state updates to prevent scroll-to-top. */
function preserveScroll(callback: () => void) {
  const main = document.querySelector('main');
  const scrollEl = main?.children[1] as HTMLElement | undefined;
  const scrollTop = scrollEl?.scrollTop ?? (typeof window !== 'undefined' ? window.scrollY : 0);
  callback();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (scrollEl) scrollEl.scrollTop = scrollTop;
      else if (typeof window !== 'undefined') window.scrollTo(0, scrollTop);
    });
  });
}

export default function HierarchicalCampaignManager() {
  const toast = useToast();
  const searchParams = useSearchParams();
  const urlCampaignId = searchParams.get('campaign_id') ? Number(searchParams.get('campaign_id')) : null;
  const urlAdGroupId = searchParams.get('ad_group_id') ? Number(searchParams.get('ad_group_id')) : null;
  const urlAdGroupName = searchParams.get('ad_group_name') ? decodeURIComponent(searchParams.get('ad_group_name')!) : '';
  const [activeTab, setActiveTab] = useState<TabType>('campaigns');
  const [dateRange, setDateRange] = useState<DateRange>({
    type: 'last_7_days',
    days: 7,
  });
  const [selectedCampaign, setSelectedCampaign] = useState<{ id: number; name: string } | null>(null);
  const [selectedAdGroup, setSelectedAdGroup] = useState<{ id: number; name: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [portfolioFilter, setPortfolioFilter] = useState<number | undefined>(undefined);
  const [campaignTypeFilter, setCampaignTypeFilter] = useState<string>('all');
  const [selectedRows, setSelectedRows] = useState<Set<string | number>>(new Set());
  const [inventoryStatuses, setInventoryStatuses] = useState<Record<string, any>>({});
  const [showPortfolioModal, setShowPortfolioModal] = useState(false);
  const [showColumnModal, setShowColumnModal] = useState(false);
  
  // Pagination state per tab
  const [campaignPage, setCampaignPage] = useState(1);
  const [campaignPageSize, setCampaignPageSize] = useState(5);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [adGroupPage, setAdGroupPage] = useState(1);
  const [adGroupPageSize, setAdGroupPageSize] = useState(5);
  const [adsPage, setAdsPage] = useState(1);
  const [adsPageSize, setAdsPageSize] = useState(5);
  const [keywordPage, setKeywordPage] = useState(1);
  const [keywordPageSize, setKeywordPageSize] = useState(5);
  const [campaignSort, setCampaignSort] = useState<{ sortKey: string; sortDirection: 'asc' | 'desc' } | null>(null);
  const [keywordSort, setKeywordSort] = useState<{ sortKey: string; sortDirection: 'asc' | 'desc' } | null>(null);

  const queryClient = useQueryClient();
  const days = useMemo(() => {
    if (dateRange.startDate && dateRange.endDate) {
      const diff = dateRange.endDate.getTime() - dateRange.startDate.getTime();
      return Math.max(1, Math.round(diff / (24 * 60 * 60 * 1000)) + 1);
    }
    return dateRange.days ?? (dateRange.type === 'last_7_days' ? 7 : dateRange.type === 'last_14_days' ? 14 : dateRange.type === 'last_30_days' ? 30 : 7);
  }, [dateRange]);

  const hasDateRange = Boolean(dateRange.startDate && dateRange.endDate);

  // Fetch trends for master chart
  const { data: trends } = useQuery({
    queryKey: ['trends', dateRange.type, dateRange.startDate?.toISOString(), dateRange.endDate?.toISOString(), days],
    queryFn: () =>
      hasDateRange ? fetchTrends(undefined, dateRange.startDate!, dateRange.endDate!) : fetchTrends(days),
    enabled: activeTab === 'campaigns',
  });

  // Fetch event annotations for chart
  const { data: eventAnnotations = [] } = useQuery<EventAnnotation[]>({
    queryKey: ['eventAnnotations', dateRange.type, dateRange.startDate?.toISOString(), dateRange.endDate?.toISOString(), days],
    queryFn: () =>
      hasDateRange ? fetchEventAnnotations(undefined, dateRange.startDate!, dateRange.endDate!) : fetchEventAnnotations(days),
    enabled: activeTab === 'campaigns',
  });

  // Calculate previous period data for comparison
  const previousPeriodData = useMemo(() => {
    if (!trends || trends.length === 0) return undefined;
    
    const periodLength = trends.length;
    const previousStartDate = new Date(trends[0].date);
    previousStartDate.setDate(previousStartDate.getDate() - periodLength);
    
    // For now, return undefined - this would need to fetch actual previous period data
    // In a real implementation, you'd fetch trends for the previous period
    return undefined;
  }, [trends]);

  // Chart data: full date range with all dates, filling 0 for missing so chart never disappears
  const chartData = useMemo(() => {
    const range = getChartDateRange(dateRange);
    if (!range) return [];
    const allDates = generateDateRange(range.start, range.end);
    const trendByDate = new Map<string, { spend: number; sales: number; acos: number; roas: number; impressions: number; clicks: number; cpc: number; ctr: number; cvr: number }>();
    (trends || []).forEach(t => {
      const d = typeof t.date === 'string' ? t.date : (t.date as Date).toISOString?.()?.split('T')[0];
      if (d) {
        trendByDate.set(d, {
          spend: typeof t.spend === 'number' ? t.spend : parseFloat(String(t.spend)) || 0,
          sales: typeof t.sales === 'number' ? t.sales : parseFloat(String(t.sales)) || 0,
          acos: typeof t.acos === 'number' ? t.acos : parseFloat(String(t.acos)) || 0,
          roas: typeof t.roas === 'number' ? t.roas : parseFloat(String(t.roas)) || 0,
          impressions: typeof t.impressions === 'number' ? t.impressions : parseInt(String(t.impressions)) || 0,
          clicks: typeof t.clicks === 'number' ? t.clicks : parseInt(String(t.clicks)) || 0,
          cpc: typeof t.cpc === 'number' ? t.cpc : parseFloat(String(t.cpc)) || 0,
          ctr: typeof t.ctr === 'number' ? t.ctr : parseFloat(String(t.ctr)) || 0,
          cvr: typeof t.cvr === 'number' ? t.cvr : parseFloat(String(t.cvr)) || 0,
        });
      }
    });
    const zeros = { spend: 0, sales: 0, acos: 0, roas: 0, impressions: 0, clicks: 0, cpc: 0, ctr: 0, cvr: 0 };
    return allDates.map(date => {
      const dateKey = date.toISOString().split('T')[0];
      const point = trendByDate.get(dateKey) || zeros;
      return {
        date: dateKey,
        ...point,
      };
    });
  }, [dateRange, trends]);

  // Breadcrumbs - Show "All Campaigns > [Campaign Name] > Ad Groups" format
  const breadcrumbs = useMemo(() => {
    const crumbs = [];
    if (selectedCampaign && activeTab !== 'campaigns' && activeTab !== 'portfolios') {
      crumbs.push({ type: 'campaigns' as TabType, id: selectedCampaign.id, name: selectedCampaign.name });
    }
    if (selectedAdGroup && (activeTab === 'keywords' || activeTab === 'targeting' || activeTab === 'search_terms' || activeTab === 'ads')) {
      crumbs.push({ type: 'ad_groups' as TabType, id: selectedAdGroup.id, name: selectedAdGroup.name });
    }
    return crumbs;
  }, [selectedCampaign, selectedAdGroup, activeTab]);

  // Queries based on active tab
  const { data: portfolios, isLoading: portfoliosLoading } = useQuery({
    queryKey: ['portfolios', days],
    queryFn: () => fetchPortfolios(days),
  });

  const { data: campaignsResponse, isLoading: campaignsLoading } = useQuery({
    queryKey: [
      'campaigns',
      days,
      portfolioFilter,
      campaignTypeFilter,
      campaignPage,
      campaignPageSize,
      urlCampaignId,
      dateRange.startDate?.toISOString(),
      dateRange.endDate?.toISOString(),
      statusFilter,
      campaignSort?.sortKey ?? null,
      campaignSort?.sortDirection ?? null,
    ],
    queryFn: () =>
      fetchCampaigns(
        days,
        portfolioFilter,
        campaignPage,
        campaignPageSize,
        urlCampaignId ?? undefined,
        dateRange.startDate,
        dateRange.endDate,
        statusFilter,
        campaignTypeFilter,
        campaignSort?.sortKey,
        campaignSort?.sortDirection
      ),
    enabled: activeTab === 'campaigns' || activeTab === 'ad_groups' || activeTab === 'ads' || activeTab === 'keywords' || activeTab === 'targeting' || activeTab === 'search_terms' || activeTab === 'placements',
  });
  const campaigns = campaignsResponse?.data;
  const campaignPagination = campaignsResponse ? { page: campaignsResponse.page, pageSize: campaignsResponse.page_size, total: campaignsResponse.total, totalPages: campaignsResponse.total_pages } : undefined;

  const { data: adGroupsResponse, isLoading: adGroupsLoading } = useQuery({
    queryKey: ['ad-groups', selectedCampaign?.id, days, adGroupPage, adGroupPageSize, statusFilter],
    queryFn: () => fetchAdGroups(selectedCampaign?.id, days, adGroupPage, adGroupPageSize, statusFilter),
    enabled: activeTab === 'ad_groups' && selectedCampaign !== null,
  });
  const adGroups = adGroupsResponse?.data;
  const adGroupPagination = adGroupsResponse ? { page: adGroupsResponse.page, pageSize: adGroupsResponse.page_size, total: adGroupsResponse.total, totalPages: adGroupsResponse.total_pages } : undefined;

  const { data: adsResponse, isLoading: adsLoading } = useQuery({
    queryKey: ['ads', selectedCampaign?.id, selectedAdGroup?.id, days, adsPage, adsPageSize, statusFilter],
    queryFn: () => fetchAds(selectedCampaign?.id, selectedAdGroup?.id, days, adsPage, adsPageSize, statusFilter),
    enabled: activeTab === 'ads' && (selectedCampaign !== null || selectedAdGroup !== null),
  });
  const ads = adsResponse?.data;
  const adsPagination = adsResponse ? { page: adsResponse.page, pageSize: adsResponse.page_size, total: adsResponse.total, totalPages: adsResponse.total_pages } : undefined;

  const { data: keywordsResponse, isLoading: keywordsLoading } = useQuery({
    queryKey: ['keywords', selectedAdGroup?.id, days, keywordPage, keywordPageSize, keywordSort?.sortKey ?? null, keywordSort?.sortDirection ?? null, statusFilter],
    queryFn: () => fetchKeywords({
      ad_group_id: selectedAdGroup?.id,
      days,
      page: keywordPage,
      page_size: keywordPageSize,
      sort_by: keywordSort?.sortKey,
      sort_order: keywordSort?.sortDirection,
      state: statusFilter !== 'all' ? statusFilter : undefined,
    }),
    enabled: activeTab === 'keywords' && selectedAdGroup !== null,
  });
  const keywords = keywordsResponse?.data;
  const keywordPagination = keywordsResponse ? { page: keywordsResponse.page, pageSize: keywordsResponse.page_size, total: keywordsResponse.total, totalPages: keywordsResponse.total_pages } : undefined;

  const { data: targeting, isLoading: targetingLoading } = useQuery({
    queryKey: ['targeting', selectedAdGroup?.id, days],
    queryFn: () => fetchProductTargeting(selectedCampaign?.id, selectedAdGroup?.id, days),
    enabled: activeTab === 'targeting' && selectedAdGroup !== null,
  });

  const { data: searchTermsResponse, isLoading: searchTermsLoading } = useQuery({
    queryKey: ['search-terms', selectedAdGroup?.id, days],
    queryFn: () => fetchSearchTerms(selectedCampaign?.id, selectedAdGroup?.id, days),
    enabled: activeTab === 'search_terms' && selectedAdGroup !== null,
  });
  const searchTerms = searchTermsResponse?.data;

  const { data: placements, isLoading: placementsLoading } = useQuery({
    queryKey: ['placements', selectedCampaign?.id, days],
    queryFn: () => fetchPlacements(selectedCampaign?.id, selectedAdGroup?.id, days),
    enabled: activeTab === 'placements' && selectedCampaign !== null,
  });

  const filteredPortfolios = useMemo(() => {
    return portfolios?.filter(p => {
      if (statusFilter === 'all') return true;
      return p.status?.toLowerCase() === statusFilter.toLowerCase();
    }) || [];
  }, [portfolios, statusFilter]);

  const filteredCampaigns = useMemo(() => {
    return campaigns?.filter(c => {
      if (statusFilter === 'all') return true;
      return c.status?.toLowerCase() === statusFilter.toLowerCase();
    }) || [];
  }, [campaigns, statusFilter]);

  const filteredAdGroups = useMemo(() => {
    return adGroups?.filter(ag => {
      if (statusFilter === 'all') return true;
      return ag.status?.toLowerCase() === statusFilter.toLowerCase();
    }) || [];
  }, [adGroups, statusFilter]);

  // When navigating from search with ad_group_id: go to Ad Groups tab and show that ad group (once)
  const hasAppliedUrlAdGroup = useRef(false);
  if (urlAdGroupId == null) hasAppliedUrlAdGroup.current = false;
  useEffect(() => {
    if (urlAdGroupId == null || hasAppliedUrlAdGroup.current) return;
    if (urlCampaignId != null && campaigns?.length) {
      const campaign = campaigns.find(c => c.campaign_id === urlCampaignId);
      if (campaign) {
        hasAppliedUrlAdGroup.current = true;
        setSelectedCampaign({ id: campaign.campaign_id, name: campaign.campaign_name });
        setSelectedAdGroup({ id: urlAdGroupId, name: urlAdGroupName || 'Ad Group' });
        setActiveTab('ad_groups');
      }
    }
  }, [urlAdGroupId, urlCampaignId, urlAdGroupName, campaigns]);

  // After ad groups load, update selected ad group name if we had a URL placeholder
  useEffect(() => {
    if (urlAdGroupId != null && selectedAdGroup?.id === urlAdGroupId && adGroups?.length && (urlAdGroupName === '' || selectedAdGroup.name === 'Ad Group')) {
      const ag = adGroups.find(g => g.ad_group_id === urlAdGroupId);
      if (ag && ag.ad_group_name !== selectedAdGroup.name) {
        setSelectedAdGroup(prev => prev ? { ...prev, name: ag.ad_group_name } : null);
      }
    }
  }, [urlAdGroupId, urlAdGroupName, selectedAdGroup, adGroups]);

  const filteredAds = useMemo(() => {
    return ads?.filter(ad => {
      if (statusFilter === 'all') return true;
      return ad.status?.toLowerCase() === statusFilter.toLowerCase();
    }) || [];
  }, [ads, statusFilter]);

  const filteredKeywords = useMemo(() => {
    return keywords?.filter(k => {
      if (statusFilter === 'all') return true;
      return k.state?.toLowerCase() === statusFilter.toLowerCase();
    }) || [];
  }, [keywords, statusFilter]);

  // Reset keywords to page 1 when status filter changes so pagination matches filtered results
  useEffect(() => {
    setKeywordPage(1);
  }, [statusFilter]);

  const actionMutation = useMutation({
    mutationFn: ({
      entityId,
      action,
    }: {
      entityId: number;
      action: { action_type: string; new_value: number; old_value?: number; reason?: string };
    }) => applyCampaignAction(entityId, action),
    onSuccess: (_data, variables) => {
      const actionLabel = variables.action.action_type === 'pause' ? 'Paused' : variables.action.action_type === 'enable' ? 'Enabled' : 'Updated';
      toast.success(`Campaign ${actionLabel}`, `Campaign ${variables.entityId} has been ${actionLabel.toLowerCase()} successfully`, {
        amazonSynced: (_data as Record<string, unknown>)?.amazon_synced as boolean | undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['ad-groups'] });
    },
    onError: (error: Error, variables) => {
      toast.error('Campaign Action Failed', `Could not ${variables.action.action_type} campaign: ${error.message}`);
    },
  });

  const handleTabChange = (tab: TabType) => {
    // Allow navigation to top-level tabs (portfolios, campaigns) - reset selections
    if (tab === 'portfolios' || tab === 'campaigns') {
      setSelectedCampaign(null);
      setSelectedAdGroup(null);
      setActiveTab(tab);
    } 
    // For drill-down tabs, require proper context
    else if (tab === 'ad_groups' && !selectedCampaign) {
      // If switching to ad_groups without a selected campaign, stay on campaigns
      setActiveTab('campaigns');
    } else if ((tab === 'ads' || tab === 'keywords' || tab === 'targeting' || tab === 'search_terms') && !selectedAdGroup && !selectedCampaign) {
      // If switching to child tabs without context, go back to campaigns
      setActiveTab('campaigns');
    } else if (tab === 'placements' && !selectedCampaign) {
      // Placements require a campaign
      setActiveTab('campaigns');
    } else {
      // Valid navigation - allow it
      setActiveTab(tab);
    }
  };

  const handleBreadcrumbClick = (item: { type: TabType; id?: number; name?: string }) => {
    if (item.type === 'campaigns' && !item.id) {
      // "All Campaigns" clicked - reset everything
      setSelectedCampaign(null);
      setSelectedAdGroup(null);
      setActiveTab('campaigns');
    } else if (item.type === 'campaigns' && item.id) {
      // Campaign name clicked - go to ad groups for that campaign
      const campaign = campaigns?.find(c => c.campaign_id === item.id);
      if (campaign) {
        setSelectedCampaign({ id: campaign.campaign_id, name: campaign.campaign_name });
        setSelectedAdGroup(null);
        setActiveTab('ad_groups');
      }
    } else if (item.type === 'ad_groups' && item.id) {
      // Ad group name clicked - go to keywords for that ad group
      const adGroup = adGroups?.find(ag => ag.ad_group_id === item.id);
      if (adGroup) {
        setSelectedAdGroup({ id: adGroup.ad_group_id, name: adGroup.ad_group_name });
        setActiveTab('keywords');
      }
    }
  };

  const handleCampaignClick = (campaign: Campaign, e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    // Auto-switch to Ad Groups tab and filter to show only ad groups within that campaign
    setSelectedCampaign({ id: campaign.campaign_id, name: campaign.campaign_name });
    setSelectedAdGroup(null);
    setActiveTab('ad_groups');
  };

  const handleAdGroupClick = (adGroup: { ad_group_id: number; ad_group_name: string }) => {
    setSelectedAdGroup({ id: adGroup.ad_group_id, name: adGroup.ad_group_name });
    setActiveTab('keywords');
  };

  function formatCsvValue(value: unknown) {
    if (value === null || value === undefined) return '';
    const stringValue = String(value);
    if (stringValue.includes('"') || stringValue.includes(',') || stringValue.includes('\n')) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  }

  function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const lines = [
      headers.map(formatCsvValue).join(','),
      ...rows.map(row => headers.map(key => formatCsvValue(row[key])).join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  const handleExportCsv = async () => {
    const today = new Date().toISOString().split('T')[0];
    let payload: { filename: string; rows: Record<string, unknown>[] };

    if (activeTab === 'campaigns') {
      setExportingCsv(true);
      try {
        const allCampaigns: Campaign[] = [];
        let page = 1;
        const pageSize = 200;
        let totalPages = 1;
        while (page <= totalPages) {
          const res = await fetchCampaigns(days, portfolioFilter, page, pageSize, undefined, dateRange.startDate, dateRange.endDate, statusFilter, campaignTypeFilter);
          allCampaigns.push(...res.data);
          totalPages = res.total_pages;
          page++;
        }
        payload = {
          filename: `campaigns-${today}.csv`,
          rows: allCampaigns.map(c => ({
            campaign_name: c.campaign_name,
            status: c.status,
            spend: c.spend,
            sales: c.sales,
            acos: c.acos,
            roas: c.roas,
            orders: c.orders,
            campaign_type: c.campaign_type,
            portfolio_name: c.portfolio_name,
          })),
        };
      } finally {
        setExportingCsv(false);
      }
    } else {
      payload = (() => {
        switch (activeTab) {
          case 'portfolios':
            return {
              filename: `portfolios-${today}.csv`,
              rows: filteredPortfolios.map(p => ({
                portfolio_name: p.portfolio_name,
                status: p.status,
                campaign_count: p.campaign_count,
                total_spend: p.total_spend,
                total_sales: p.total_sales,
                acos: p.acos,
              })),
            };
          case 'ad_groups':
          return {
            filename: `ad-groups-${today}.csv`,
            rows: filteredAdGroups.map(ag => ({
              ad_group_name: ag.ad_group_name,
              status: ag.status,
              spend: ag.spend,
              sales: ag.sales,
              acos: ag.acos,
              orders: ag.orders,
            })),
          };
        case 'ads':
          return {
            filename: `ads-${today}.csv`,
            rows: filteredAds.map(ad => ({
              asin: ad.asin,
              sku: ad.sku,
              status: ad.status,
              impressions: ad.impressions,
              clicks: ad.clicks,
              spend: ad.spend,
              sales: ad.sales,
              acos: ad.acos,
              roas: ad.roas,
              orders: ad.orders,
            })),
          };
        case 'keywords':
          return {
            filename: `keywords-${today}.csv`,
            rows: filteredKeywords.map(k => ({
              keyword_text: k.keyword_text,
              match_type: k.match_type,
              bid: k.bid,
              spend: k.spend,
              sales: k.sales,
              acos: k.acos,
              orders: k.orders,
            })),
          };
        case 'targeting':
          return {
            filename: `targeting-${today}.csv`,
            rows: (targeting || []).map(t => ({
              target_value: t.target_value,
              target_type: t.target_type,
              bid: t.bid,
              spend: t.spend,
              sales: t.sales,
              acos: t.acos,
            })),
          };
        case 'search_terms':
          return {
            filename: `search-terms-${today}.csv`,
            rows: (searchTerms || []).map(t => ({
              search_term: t.search_term,
              impressions: t.impressions,
              clicks: t.clicks,
              spend: t.spend,
              sales: t.sales,
              orders: t.orders,
              harvest_action: t.harvest_action,
            })),
          };
        case 'placements':
          return {
            filename: `placements-${today}.csv`,
            rows: (placements || []).map(p => ({
              placement: p.placement,
              impressions: p.impressions,
              clicks: p.clicks,
              spend: p.spend,
              sales: p.sales,
              acos: p.acos,
            })),
          };
        default:
          return { filename: `export-${today}.csv`, rows: [] };
        }
      })();
    }
    downloadCsv(payload.filename, payload.rows);
  };

  // Render content based on active tab
  const renderTabContent = () => {
    const isLoading = 
      (activeTab === 'portfolios' && portfoliosLoading) ||
      (activeTab === 'campaigns' && campaignsLoading) ||
      (activeTab === 'ad_groups' && adGroupsLoading) ||
      (activeTab === 'ads' && adsLoading) ||
      (activeTab === 'keywords' && keywordsLoading) ||
      (activeTab === 'targeting' && targetingLoading) ||
      (activeTab === 'search_terms' && searchTermsLoading) ||
      (activeTab === 'placements' && placementsLoading);

    if (isLoading) {
      return (
        <div className="card p-8 text-center">
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mx-auto" />
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/2 mx-auto" />
          </div>
        </div>
      );
    }

    switch (activeTab) {
      case 'portfolios':
        return renderPortfolios();
      case 'campaigns':
        return renderCampaigns();
      case 'ad_groups':
        if (!selectedCampaign) {
          return (
            <div className="card p-8 text-center text-gray-500">
              <Target className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Select a campaign to view ad groups</p>
            </div>
          );
        }
        return renderAdGroups();
      case 'ads':
        if (!selectedCampaign && !selectedAdGroup) {
          return (
            <div className="card p-8 text-center text-gray-500">
              <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Select a campaign or ad group to view ads</p>
            </div>
          );
        }
        return renderAds();
      case 'keywords':
        if (!selectedAdGroup) {
          return (
            <div className="card p-8 text-center text-gray-500">
              <Filter className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Select an ad group to view keywords</p>
            </div>
          );
        }
        return renderKeywords();
      case 'targeting':
        if (!selectedAdGroup) {
          return (
            <div className="card p-8 text-center text-gray-500">
              <Filter className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Select an ad group to view product targeting</p>
            </div>
          );
        }
        return renderTargeting();
      case 'search_terms':
        if (!selectedAdGroup) {
          return (
            <div className="card p-8 text-center text-gray-500">
              <Filter className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Select an ad group to view search terms</p>
            </div>
          );
        }
        return renderSearchTerms();
      case 'placements':
        if (!selectedCampaign) {
          return (
            <div className="card p-8 text-center text-gray-500">
              <Filter className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Select a campaign to view placements</p>
            </div>
          );
        }
        return renderPlacements();
      default:
        return null;
    }
  };

  const renderPortfolios = () => {
    return (
      <SmartGrid
        data={filteredPortfolios}
        columns={[
          {
            key: 'portfolio_name',
            header: 'Portfolio Name',
            sortable: true,
            render: (value: unknown, row: any) => (
              <div>
                <p className="font-medium text-gray-900 dark:text-white">{row.portfolio_name}</p>
              </div>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            sortable: true,
            render: (value: unknown, row: any) => (
              <span className={cn('badge', getStatusBadge(row.status))}>
                {row.status}
              </span>
            ),
          },
          {
            key: 'campaign_count',
            header: 'Campaigns',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
          {
            key: 'total_spend',
            header: 'Spend',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'total_sales',
            header: 'Sales',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono text-green-400">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'acos',
            header: 'ACOS',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => {
              const acos = value as number | null;
              const color = acos === null ? 'text-gray-400' :
                acos < 9 ? 'text-green-400' :
                acos < 15 ? 'text-yellow-400' :
                'text-red-400';
              return <span className={cn('font-mono', color)}>{formatAcos(acos)}</span>;
            },
          },
        ]}
        keyField="portfolio_id"
        loading={portfoliosLoading}
        emptyMessage="No portfolios found"
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => preserveScroll(() => setStatusFilter(v))}
      />
    );
  };

  const renderCampaigns = () => {
    return (
      <div className="space-y-4">
        {/* Toolbar */}
        <div className="card p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <select
                  value={portfolioFilter || ''}
                  onChange={(e) => preserveScroll(() => setPortfolioFilter(e.target.value ? parseInt(e.target.value) : undefined))}
                  className="select text-sm"
                >
                  <option value="">All Portfolios</option>
                  {portfolios?.map((p: Portfolio) => (
                    <option key={p.portfolio_id} value={p.portfolio_id.toString()}>
                      {p.portfolio_name}
                    </option>
                  ))}
                </select>
                <select
                  value={campaignTypeFilter}
                  onChange={(e) => preserveScroll(() => { setCampaignTypeFilter(e.target.value); setCampaignPage(1); setSelectedRows(new Set()); })}
                  className="select text-sm"
                >
                  <option value="all">All Campaigns</option>
                  <option value="SP">Sponsored Products</option>
                  <option value="SB">Sponsored Brands</option>
                  <option value="SD">Sponsored Display</option>
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn btn-sm btn-secondary"
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleExportCsv()}
                className="btn btn-sm btn-secondary"
                disabled={exportingCsv}
              >
                {exportingCsv ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Exporting...
                  </>
                ) : (
                  <>
                    <FileDown className="w-4 h-4" />
                    Export CSV
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
        <SmartGrid
          data={filteredCampaigns}
          statusFilter={statusFilter}
          onStatusFilterChange={(v) => preserveScroll(() => setStatusFilter(v))}
        statusFilterOptions={[
            { value: 'all', label: 'All Status' },
            { value: 'enabled', label: 'Enabled' },
            { value: 'paused', label: 'Paused' },
            { value: 'archived', label: 'Archived' },
          ]}
          enableSelection
          selectedRows={selectedRows}
          onSelectRow={(id) => {
            const strId = String(id);
            const newSelection = new Set(selectedRows);
            if (newSelection.has(strId)) {
              newSelection.delete(strId);
            } else {
              newSelection.add(strId);
            }
            setSelectedRows(newSelection);
          }}
          onSelectAllRows={(ids, select) => {
            const newSelection = new Set(selectedRows);
            if (select) {
              ids.forEach(id => newSelection.add(String(id)));
            } else {
              ids.forEach(id => newSelection.delete(String(id)));
            }
            setSelectedRows(newSelection);
          }}
          onBulkAction={async (action, ids, params) => {
            try {
              if (action === 'move_to_portfolio' && params?.portfolioId) {
                await bulkAddCampaignsToPortfolio(ids.map(id => Number(id)), params.portfolioId);
                toast.success('Portfolio Updated', `${ids.length} campaign(s) moved to portfolio`);
              } else if (action === 'pause' || action === 'enable' || action === 'archive') {
                console.log(`Bulk ${action} action for ${ids.length} campaigns`);
                toast.info('Bulk Action', `${ids.length} campaign(s) will be ${action}d`);
              }
              queryClient.invalidateQueries({ queryKey: ['campaigns'] });
            } catch (error) {
              console.error(`Failed to perform bulk ${action}:`, error);
              toast.error('Bulk Action Failed', `Failed to ${action} ${ids.length} campaigns. Please try again.`);
            }
          }}
        columns={[
          {
            key: 'campaign_name',
            header: 'Campaign Name',
            width: 320,
            sortable: true,
            render: (value: unknown, row: Campaign) => (
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={(e) => handleCampaignClick(row, e)}
                  className="text-left hover:text-amazon-orange transition-colors flex-1 min-w-0"
                  type="button"
                  title={row.campaign_name}
                >
                  <p className="font-medium text-gray-900 dark:text-white truncate" title={row.campaign_name}>{row.campaign_name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-gray-400">{row.campaign_type}</span>
                    {row.sb_ad_type && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
                        {row.sb_ad_type.replace(/_/g, ' ')}
                      </span>
                    )}
                    {row.sd_targeting_type && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300">
                        {row.sd_targeting_type}
                      </span>
                    )}
                    {row.portfolio_name && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                        {row.portfolio_name}
                      </span>
                    )}
                  </div>
                </button>
                <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
              </div>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            sortable: true,
            render: (value: unknown, row: Campaign) => (
              <span className={cn('badge', getStatusBadge(row.status))}>
                {row.status}
              </span>
            ),
          },
          {
            key: 'spend',
            header: 'Spend',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'sales',
            header: 'Sales',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono text-green-400">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'acos',
            header: 'ACOS',
            sortable: true,
            className: 'text-right',
            render: (value: unknown, row: Campaign) => {
              const acos = row.acos;
              const color = acos === null ? 'text-gray-400' :
                acos < 9 ? 'text-green-400' :
                acos < 15 ? 'text-yellow-400' :
                'text-red-400';
              return <span className={cn('font-mono', color)}>{formatAcos(acos)}</span>;
            },
          },
          {
            key: 'roas',
            header: 'ROAS',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatRoas(value as number)}</span>
            ),
          },
          {
            key: 'orders',
            header: 'Orders',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (value: unknown, row: Campaign) => (
              <div className="flex items-center gap-2">
                {String(row.status || '').toLowerCase() === 'enabled' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      actionMutation.mutate({
                        entityId: row.campaign_id,
                        action: { action_type: 'pause', new_value: 0, reason: 'Manual pause from dashboard' },
                      });
                    }}
                    className="btn btn-sm btn-secondary"
                    title="Pause Campaign"
                  >
                    <Pause className="w-3 h-3" />
                  </button>
                )}
                {String(row.status || '').toLowerCase() !== 'enabled' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      actionMutation.mutate({
                        entityId: row.campaign_id,
                        action: { action_type: 'enable', new_value: 1, reason: 'Manual enable from dashboard' },
                      });
                    }}
                    className="btn btn-sm btn-secondary"
                    title="Enable Campaign"
                  >
                    <Play className="w-3 h-3" />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowPortfolioModal(true);
                    setSelectedRows(new Set([String(row.campaign_id)]));
                  }}
                  className="btn btn-sm btn-secondary"
                  title={row.portfolio_id ? 'Move to Portfolio' : 'Add to Portfolio'}
                >
                  <Package className="w-3 h-3" />
                </button>
              </div>
            ),
          },
        ]}
        keyField="campaign_id"
        loading={campaignsLoading}
        emptyMessage="No campaigns found"
        pagination={campaignPagination}
        onPageChange={(p) => { setCampaignPage(p); setSelectedRows(new Set()); }}
        onPageSizeChange={(s) => preserveScroll(() => { setCampaignPageSize(s); setCampaignPage(1); setSelectedRows(new Set()); })}
        sort={campaignSort}
        onSortChange={(key, direction) => {
          preserveScroll(() => {
            setCampaignSort({ sortKey: key, sortDirection: direction });
            setCampaignPage(1);
            setSelectedRows(new Set());
          });
        }}
        />
      </div>
    );
  };

  const renderAdGroups = () => {
    return (
      <SmartGrid
        data={filteredAdGroups}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => preserveScroll(() => setStatusFilter(v))}
        columns={[
          {
            key: 'ad_group_name',
            header: 'Ad Group Name',
            width: 280,
            sortable: true,
            render: (value: unknown, row: any) => (
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => handleAdGroupClick(row)}
                  className="text-left hover:text-amazon-orange transition-colors flex-1 min-w-0"
                  title={row.ad_group_name}
                >
                  <p className="font-medium text-gray-900 dark:text-white truncate" title={row.ad_group_name}>{row.ad_group_name}</p>
                </button>
                <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
              </div>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            sortable: true,
            render: (value: unknown, row: any) => (
              <span className={cn('badge', getStatusBadge(row.status))}>
                {row.status}
              </span>
            ),
          },
          {
            key: 'spend',
            header: 'Spend',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'sales',
            header: 'Sales',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono text-green-400">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'acos',
            header: 'ACOS',
            sortable: true,
            className: 'text-right',
            render: (value: unknown, row: any) => {
              const acos = row.acos;
              const color = acos === null ? 'text-gray-400' :
                acos < 9 ? 'text-green-400' :
                acos < 15 ? 'text-yellow-400' :
                'text-red-400';
              return <span className={cn('font-mono', color)}>{formatAcos(acos)}</span>;
            },
          },
          {
            key: 'orders',
            header: 'Orders',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
        ]}
        keyField="ad_group_id"
        loading={adGroupsLoading}
        emptyMessage="No ad groups found"
        pagination={adGroupPagination}
        onPageChange={setAdGroupPage}
        onPageSizeChange={(s) => preserveScroll(() => { setAdGroupPageSize(s); setAdGroupPage(1); })}
      />
    );
  };

  const renderAds = () => {
    return (
      <SmartGrid
        data={filteredAds}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => preserveScroll(() => setStatusFilter(v))}
        columns={[
          {
            key: 'asin',
            header: 'ASIN',
            sortable: true,
            render: (value: unknown, row: any) => (
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900 dark:text-white">{value as string}</span>
                {row.inventory_status && (
                  <InventoryBadge inventoryStatus={row.inventory_status} />
                )}
              </div>
            ),
          },
          {
            key: 'sku',
            header: 'SKU',
            sortable: true,
            render: (value: unknown) => (
              <span className="text-gray-600 dark:text-gray-400">{value as string || '-'}</span>
            ),
          },
          {
            key: 'status',
            header: 'Status',
            sortable: true,
            render: (value: unknown, row: any) => (
              <span className={cn('badge', getStatusBadge(row.status))}>
                {row.status}
              </span>
            ),
          },
          {
            key: 'impressions',
            header: 'Impressions',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
          {
            key: 'clicks',
            header: 'Clicks',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
          {
            key: 'spend',
            header: 'Spend',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'sales',
            header: 'Sales',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono text-green-400">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'acos',
            header: 'ACOS',
            sortable: true,
            className: 'text-right',
            render: (value: unknown, row: any) => {
              const acos = row.acos;
              const color = acos === null ? 'text-gray-400' :
                acos < 9 ? 'text-green-400' :
                acos < 15 ? 'text-yellow-400' :
                'text-red-400';
              return <span className={cn('font-mono', color)}>{formatAcos(acos)}</span>;
            },
          },
          {
            key: 'roas',
            header: 'ROAS',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatRoas(value as number)}</span>
            ),
          },
          {
            key: 'orders',
            header: 'Orders',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
        ]}
        keyField="ad_id"
        loading={adsLoading}
        emptyMessage="No ads found"
        pagination={adsPagination}
        onPageChange={setAdsPage}
        onPageSizeChange={(s) => preserveScroll(() => { setAdsPageSize(s); setAdsPage(1); })}
      />
    );
  };

  const renderKeywords = () => {
    return (
      <SmartGrid
        data={filteredKeywords}
        statusFilter={statusFilter}
        onStatusFilterChange={(v) => preserveScroll(() => setStatusFilter(v))}
        columns={[
          {
            key: 'keyword_text',
            header: 'Keyword',
            width: 260,
            sortable: true,
            render: (value: unknown) => (
              <span className="font-medium text-gray-900 dark:text-white truncate block min-w-0" title={value as string}>{value as string}</span>
            ),
          },
          {
            key: 'match_type',
            header: 'Match Type',
            sortable: true,
            render: (value: unknown) => (
              <span className="badge badge-info">{value as string}</span>
            ),
          },
          {
            key: 'bid',
            header: 'Bid',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'spend',
            header: 'Spend',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'sales',
            header: 'Sales',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono text-green-400">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'acos',
            header: 'ACOS',
            sortable: true,
            className: 'text-right',
            render: (value: unknown, row: any) => {
              const acos = row.acos;
              const color = acos === null ? 'text-gray-400' :
                acos < 9 ? 'text-green-400' :
                acos < 15 ? 'text-yellow-400' :
                'text-red-400';
              return <span className={cn('font-mono', color)}>{formatAcos(acos)}</span>;
            },
          },
          {
            key: 'orders',
            header: 'Orders',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
        ]}
        keyField="keyword_id"
        loading={keywordsLoading}
        emptyMessage="No keywords found"
        pagination={keywordPagination}
        onPageChange={setKeywordPage}
        onPageSizeChange={(s) => preserveScroll(() => { setKeywordPageSize(s); setKeywordPage(1); })}
        sort={keywordSort}
        onSortChange={(key, direction) => {
          preserveScroll(() => {
            setKeywordSort({ sortKey: key, sortDirection: direction });
            setKeywordPage(1);
          });
        }}
      />
    );
  };

  const renderTargeting = () => {
    return (
      <SmartGrid
        data={targeting || []}
        columns={[
          {
            key: 'target_value',
            header: 'Target',
            width: 260,
            sortable: true,
            render: (value: unknown, row: any) => {
              const raw = value != null && String(value).trim() !== '' ? String(value) : '';
              const v = raw || row.campaign_name || '-';
              return (
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 dark:text-white truncate" title={v}>{v}</p>
                  <p className="text-xs text-gray-400">{row.target_type || '-'}</p>
                </div>
              );
            },
          },
          {
            key: 'bid',
            header: 'Bid',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'spend',
            header: 'Spend',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'sales',
            header: 'Sales',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono text-green-400">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'acos',
            header: 'ACOS',
            sortable: true,
            className: 'text-right',
            render: (value: unknown, row: any) => {
              const acos = row.acos;
              const color = acos === null ? 'text-gray-400' :
                acos < 9 ? 'text-green-400' :
                acos < 15 ? 'text-yellow-400' :
                'text-red-400';
              return <span className={cn('font-mono', color)}>{formatAcos(acos)}</span>;
            },
          },
        ]}
        keyField="target_id"
        loading={targetingLoading}
        emptyMessage="No product targeting found"
      />
    );
  };

  const handleAddAsKeyword = async (searchTerm: SearchTerm) => {
    try {
      await addSearchTermAsKeyword(
        searchTerm.search_term,
        searchTerm.campaign_id,
        searchTerm.ad_group_id,
        'PHRASE' // Default match type
      );
      queryClient.invalidateQueries({ queryKey: ['search-terms'] });
      queryClient.invalidateQueries({ queryKey: ['keywords'] });
    } catch (error) {
      console.error('Failed to add search term as keyword:', error);
    }
  };

  const handleAddAsNegative = async (searchTerm: SearchTerm) => {
    try {
      await addSearchTermAsNegative(
        searchTerm.search_term,
        searchTerm.campaign_id,
        searchTerm.ad_group_id,
        'negative_phrase' // Default match type
      );
      queryClient.invalidateQueries({ queryKey: ['search-terms'] });
    } catch (error) {
      console.error('Failed to add search term as negative:', error);
    }
  };

  const renderSearchTerms = () => {
    return (
      <SmartGrid
        data={searchTerms || []}
        columns={[
          {
            key: 'search_term',
            header: 'Search Term',
            width: 280,
            sortable: true,
            render: (value: unknown) => (
              <span className="font-medium text-gray-900 dark:text-white truncate block min-w-0" title={value as string}>{value as string}</span>
            ),
          },
          {
            key: 'impressions',
            header: 'Impressions',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
          {
            key: 'clicks',
            header: 'Clicks',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
          {
            key: 'spend',
            header: 'Spend',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'sales',
            header: 'Sales',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono text-green-400">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'orders',
            header: 'Orders',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
          {
            key: 'harvest_action',
            header: 'Action',
            render: (value: unknown, row: any) => {
              const term = row as SearchTerm;
              if (term.harvest_action === 'add_keyword') {
                return (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddAsKeyword(term);
                    }}
                    className="btn btn-sm btn-success"
                  >
                    Add as Keyword
                  </button>
                );
              } else if (term.harvest_action === 'add_negative') {
                return (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleAddAsNegative(term);
                    }}
                    className="btn btn-sm btn-danger"
                  >
                    Add as Negative
                  </button>
                );
              }
              return null;
            },
          },
        ]}
        keyField="search_term"
        loading={searchTermsLoading}
        emptyMessage="No search terms found"
      />
    );
  };

  const renderPlacements = () => {
    return (
      <SmartGrid
        data={placements || []}
        columns={[
          {
            key: 'placement',
            header: 'Placement',
            sortable: true,
            render: (value: unknown) => (
              <span className="font-medium text-gray-900 dark:text-white">{value as string}</span>
            ),
          },
          {
            key: 'impressions',
            header: 'Impressions',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
          {
            key: 'clicks',
            header: 'Clicks',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => formatNumber(value as number),
          },
          {
            key: 'spend',
            header: 'Spend',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'sales',
            header: 'Sales',
            sortable: true,
            className: 'text-right',
            render: (value: unknown) => (
              <span className="font-mono text-green-400">{formatCurrency(value as number)}</span>
            ),
          },
          {
            key: 'acos',
            header: 'ACOS',
            sortable: true,
            className: 'text-right',
            render: (value: unknown, row: any) => {
              const acos = row.acos;
              const color = acos === null ? 'text-gray-400' :
                acos < 9 ? 'text-green-400' :
                acos < 15 ? 'text-yellow-400' :
                'text-red-400';
              return <span className={cn('font-mono', color)}>{formatAcos(acos)}</span>;
            },
          },
        ]}
        keyField="placement"
        loading={placementsLoading}
        emptyMessage="No placement data found"
      />
    );
  };

  return (
    <div id="campaign-manager-content" className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Campaign Manager</h1>
          <p className="text-gray-400 mt-1">
            Hierarchical view of your advertising structure
          </p>
        </div>
        <div className="flex items-center gap-3">
          <DateRangePicker value={dateRange} onChange={(range) => preserveScroll(() => setDateRange(range))} />
          <button
            onClick={() => queryClient.invalidateQueries()}
            className="btn btn-secondary"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Hierarchical Tabs */}
      <HierarchicalTabs
        activeTab={activeTab}
        onTabChange={handleTabChange}
        breadcrumbs={breadcrumbs}
        onBreadcrumbClick={handleBreadcrumbClick}
      />

      {/* Portfolio Modal */}
      {showPortfolioModal && (
        <PortfolioModal
          portfolios={portfolios || []}
          onClose={() => setShowPortfolioModal(false)}
          onSelect={async (portfolioId: number) => {
            try {
              const campaignIds = Array.from(selectedRows).map(id => Number(id));
              if (campaignIds.length === 1) {
                await addCampaignToPortfolio(campaignIds[0], portfolioId);
              } else {
                await bulkAddCampaignsToPortfolio(campaignIds, portfolioId);
              }
              queryClient.invalidateQueries({ queryKey: ['campaigns'] });
              setShowPortfolioModal(false);
              setSelectedRows(new Set());
            } catch (error) {
              console.error('Failed to add campaign to portfolio:', error);
            }
          }}
        />
      )}

      {/* Master Performance Chart (shown for campaigns tab; all dates in range, 0 when no data) */}
      {activeTab === 'campaigns' && chartData.length > 0 && (
        <MasterPerformanceChart
          data={chartData}
          previousPeriodData={previousPeriodData}
          eventAnnotations={eventAnnotations}
          height={400}
        />
      )}

      {/* Tab Content */}
      <div key={activeTab}>
        {renderTabContent()}
      </div>
    </div>
  );
}

// Portfolio Modal Component
function PortfolioModal({
  portfolios,
  onClose,
  onSelect,
}: {
  portfolios: Portfolio[];
  onClose: () => void;
  onSelect: (portfolioId: number) => void;
}) {
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<number | null>(null);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="card p-6 max-w-md w-full">
        <h2 className="text-xl font-bold mb-4">Add Campaign to Portfolio</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Select Portfolio</label>
            <select
              value={selectedPortfolioId || ''}
              onChange={(e) => setSelectedPortfolioId(e.target.value ? parseInt(e.target.value) : null)}
              className="select w-full"
            >
              <option value="">Choose a portfolio...</option>
              {portfolios.map((p) => (
                <option key={p.portfolio_id} value={p.portfolio_id.toString()}>
                  {p.portfolio_name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button
              onClick={() => {
                if (selectedPortfolioId) {
                  onSelect(selectedPortfolioId);
                }
              }}
              disabled={!selectedPortfolioId}
              className="btn btn-primary"
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

