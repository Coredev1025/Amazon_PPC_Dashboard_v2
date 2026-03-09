'use client';

import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/contexts/ToastContext';
import {
  Filter,
  Download,
  RefreshCw,
  Edit3,
  Check,
  X,
  TrendingUp,
  TrendingDown,
  Lock,
  Unlock,
  AlertCircle,
} from 'lucide-react';
import SmartGrid from '@/components/SmartGrid';
import DateRangePicker, { type DateRange } from '@/components/DateRangePicker';
import { fetchKeywords, updateKeywordBid, lockKeywordBid, unlockKeywordBid, type Keyword } from '@/utils/api';
import {
  formatCurrency,
  formatAcos,
  formatRoas,
  formatNumber,
  formatPercentage,
  cn,
} from '@/utils/helpers';
import * as XLSX from 'xlsx';

export default function KeywordsPage() {
  const toast = useToast();
  const searchParams = useSearchParams();
  const urlKeywordId = searchParams.get('keyword_id') ? Number(searchParams.get('keyword_id')) : null;
  const [dateRange, setDateRange] = useState<DateRange>({
    type: 'last_7_days',
    days: 7,
  });
  const [matchTypeFilter, setMatchTypeFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [editingKeyword, setEditingKeyword] = useState<number | null>(null);
  const [editBidValue, setEditBidValue] = useState<string>('');
  const [lockingKeyword, setLockingKeyword] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState<{ sortKey: string; sortDirection: 'asc' | 'desc' } | null>(null);

  const queryClient = useQueryClient();

  // Reset to page 1 when date range changes
  useEffect(() => {
    setPage(1);
  }, [dateRange.type, dateRange.startDate?.toISOString(), dateRange.endDate?.toISOString()]);

  // Calculate days from dateRange
  const days = dateRange.days || (dateRange.type === 'last_7_days' ? 7 : dateRange.type === 'last_14_days' ? 14 : dateRange.type === 'last_30_days' ? 30 : 7);

  const { data: keywordsResponse, isLoading, refetch } = useQuery({
    queryKey: ['keywords', dateRange.type, dateRange.startDate?.toISOString(), dateRange.endDate?.toISOString(), page, pageSize, urlKeywordId, stateFilter, matchTypeFilter, sort?.sortKey ?? null, sort?.sortDirection ?? null],
    queryFn: () =>
      fetchKeywords({
        days,
        page,
        page_size: pageSize,
        ...(urlKeywordId ? { keyword_id: urlKeywordId } : {}),
        ...(stateFilter && stateFilter !== 'all' ? { state: stateFilter } : {}),
        ...(matchTypeFilter && matchTypeFilter !== 'all' ? { match_type: matchTypeFilter } : {}),
        sort_by: sort?.sortKey,
        sort_order: sort?.sortDirection,
      }),
  });

  const keywords = keywordsResponse?.data;

  // Note: auto-refresh is handled via Layout's LiveSettings context for nav badges

  const bidMutation = useMutation({
    mutationFn: ({ keywordId, newBid, oldBid }: { keywordId: number; newBid: number; oldBid: number }) =>
      updateKeywordBid(keywordId, { new_value: newBid, old_value: oldBid }),
    onSuccess: (_data, variables) => {
      toast.success('Bid Updated', `Keyword bid changed to $${variables.newBid.toFixed(2)}`, {
        amazonSynced: (_data as Record<string, unknown>)?.amazon_synced as boolean | undefined,
      });
      queryClient.invalidateQueries({ queryKey: ['keywords'] });
      setEditingKeyword(null);
    },
    onError: (error: Error) => {
      toast.error('Bid Update Failed', error.message);
    },
  });

  const lockMutation = useMutation({
    mutationFn: ({ keywordId, days }: { keywordId: number; days: number }) =>
      lockKeywordBid(keywordId, days, 'Manual lock from dashboard'),
    onSuccess: (_data, variables) => {
      toast.success('Keyword Locked', `Bid locked for ${variables.days} days`);
      queryClient.invalidateQueries({ queryKey: ['keywords'] });
      setLockingKeyword(null);
    },
    onError: (error: Error) => {
      toast.error('Lock Failed', error.message);
    },
  });

  const unlockMutation = useMutation({
    mutationFn: (keywordId: number) => unlockKeywordBid(keywordId),
    onSuccess: () => {
      toast.success('Keyword Unlocked', 'Bid is now open for AI optimization');
      queryClient.invalidateQueries({ queryKey: ['keywords'] });
    },
    onError: (error: Error) => {
      toast.error('Unlock Failed', error.message);
    },
  });

  const filteredKeywords = keywords?.filter((k) => {
    if (matchTypeFilter !== 'all' && k.match_type?.toLowerCase() !== matchTypeFilter.toLowerCase()) return false;
    if (stateFilter !== 'all' && k.state?.toLowerCase() !== stateFilter.toLowerCase()) return false;
    return true;
  });

  const handleExport = async () => {
    try {
      setExporting(true);
      toast.info('Exporting', 'Loading all keywords from database...');

      const allKeywords: Keyword[] = [];
      let currentPage = 1;
      const batchSize = 200;
      let totalPages = 1;

      while (currentPage <= totalPages) {
        const res = await fetchKeywords({
          days,
          page: currentPage,
          page_size: batchSize,
          ...(stateFilter && stateFilter !== 'all' ? { state: stateFilter } : {}),
        });
        allKeywords.push(...res.data);
        totalPages = res.total_pages;
        currentPage++;
      }

      const rows = allKeywords.map(k => ({
        'Keyword': k.keyword_text,
        'Match': k.match_type,
        'State': k.state,
        'Current Bid': k.bid ?? 0,
        'AI Suggested': k.ai_suggested_bid ?? '',
        'Spend': k.spend ?? 0,
        'Sales': k.sales ?? 0,
        'ACOS': k.acos != null ? `${k.acos}%` : '-',
      }));

      const ws = XLSX.utils.json_to_sheet(rows);

      const colWidths = [
        { wch: 35 }, // Keyword
        { wch: 10 }, // Match
        { wch: 10 }, // State
        { wch: 12 }, // Current Bid
        { wch: 14 }, // AI Suggested
        { wch: 12 }, // Spend
        { wch: 12 }, // Sales
        { wch: 10 }, // ACOS
      ];
      ws['!cols'] = colWidths;

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Keywords');

      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      XLSX.writeFile(wb, `keywords_${ts}.xlsx`);

      toast.success('Export Complete', `${allKeywords.length} keywords exported`);
    } catch (err) {
      console.error('Export failed:', err);
      toast.error('Export Failed', 'Could not export keywords');
    } finally {
      setExporting(false);
    }
  };

  const handleEditBid = (keyword: Keyword) => {
    if (keyword.is_locked) {
      toast.warning('Keyword Locked', `This keyword is locked: ${keyword.lock_reason}`);
      return;
    }
    setEditingKeyword(keyword.keyword_id);
    setEditBidValue((keyword.bid ?? 0).toFixed(2));
  };

  const handleSaveBid = (keyword: Keyword) => {
    const newBid = parseFloat(editBidValue);
    if (!isNaN(newBid) && newBid > 0) {
      bidMutation.mutate({
        keywordId: keyword.keyword_id,
        newBid,
        oldBid: keyword.bid,
      });
    }
  };

  const handleLock = (keyword: Keyword, days: number) => {
    lockMutation.mutate({ keywordId: keyword.keyword_id, days });
  };

  const handleUnlock = (keyword: Keyword) => {
    unlockMutation.mutate(keyword.keyword_id);
  };

  const getMatchTypeBadge = (matchType: string) => {
    const type = matchType?.toLowerCase();
    const badges: Record<string, string> = {
      exact: 'bg-blue-500/20 text-blue-400',
      phrase: 'bg-purple-500/20 text-purple-400',
      broad: 'bg-gray-500/20 text-gray-400',
    };
    return badges[type] || 'bg-gray-500/20 text-gray-400';
  };

  const getStateBadge = (state: string) => {
    const s = state?.toLowerCase();
    if (s === 'enabled') return 'badge-success';
    if (s === 'paused') return 'badge-warning';
    return 'badge-neutral';
  };

  const columns = [
    {
      key: 'keyword_text',
      header: 'Keyword',
      width: 280,
      sortable: true,
      render: (value: unknown, row: Keyword) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="font-medium text-gray-900 dark:text-white truncate" title={row.keyword_text}>{row.keyword_text}</p>
            {row.is_locked && (
              <span title={row.lock_reason || 'Locked'}>
                <Lock className="w-3 h-3 text-amber-400 flex-shrink-0" />
              </span>
            )}
          </div>
          {row.is_locked && (
            <p className="text-xs text-amber-400/80 truncate" title={row.lock_reason || ''}>{row.lock_reason}</p>
          )}
        </div>
      ),
    },
    {
      key: 'match_type',
      header: 'Match',
      sortable: true,
      render: (value: unknown, row: Keyword) => (
        <span className={cn('badge', getMatchTypeBadge(row.match_type))}>
          {row.match_type}
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      sortable: true,
      render: (value: unknown, row: Keyword) => (
        <span className={cn('badge', getStateBadge(row.state))}>
          {row.state}
        </span>
      ),
    },
    {
      key: 'bid',
      header: 'Current Bid',
      sortable: true,
      className: 'text-right',
      render: (value: unknown, row: Keyword) => {
        if (editingKeyword === row.keyword_id) {
          return (
            <div className="flex items-center gap-2 justify-end">
              <input
                type="number"
                value={editBidValue}
                onChange={(e) => setEditBidValue(e.target.value)}
                className="input w-24 py-1 px-2 text-right"
                step="0.01"
                min="0.02"
                autoFocus
              />
              <button
                onClick={() => handleSaveBid(row)}
                className="p-1 text-green-400 hover:bg-green-500/20 rounded"
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                onClick={() => setEditingKeyword(null)}
                className="p-1 text-red-400 hover:bg-red-500/20 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        }
        return (
          <div className="flex items-center gap-2 justify-end">
            <span className={cn('font-mono', row.is_locked && 'text-amber-400')}>{formatCurrency(row.bid)}</span>
            {!row.is_locked ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleEditBid(row);
                }}
                className="p-1 text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 rounded opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Edit3 className="w-3 h-3" />
              </button>
            ) : (
              <Lock className="w-3 h-3 text-amber-400" />
            )}
          </div>
        );
      },
    },
    {
      key: 'ai_suggested_bid',
      header: 'Suggested bid',
      sortable: true,
      className: 'text-right',
      render: (value: unknown, row: Keyword) => {
        if (!row.ai_suggested_bid) return <span className="text-gray-500">-</span>;
        
        const diff = ((row.ai_suggested_bid - row.bid) / row.bid) * 100;
        const isIncrease = diff > 0;
        
        return (
          <div className="flex items-center gap-2 justify-end">
            <span className={cn(
              'font-mono',
              isIncrease ? 'text-green-400' : 'text-red-400'
            )}>
              {formatCurrency(row.ai_suggested_bid)}
            </span>
            {isIncrease ? (
              <TrendingUp className="w-3 h-3 text-green-400" />
            ) : (
              <TrendingDown className="w-3 h-3 text-red-400" />
            )}
          </div>
        );
      },
    },
    {
      key: 'spend',
      header: 'Spend',
      sortable: true,
      className: 'text-right',
      render: (value: unknown, row: Keyword) => (
        <span className="font-mono">{formatCurrency(row.spend)}</span>
      ),
    },
    {
      key: 'sales',
      header: 'Sales',
      sortable: true,
      className: 'text-right',
      render: (value: unknown, row: Keyword) => (
        <span className="font-mono text-green-400">{formatCurrency(row.sales)}</span>
      ),
    },
    {
      key: 'acos',
      header: 'ACOS',
      sortable: true,
      className: 'text-right',
      render: (value: unknown, row: Keyword) => {
        const acos = row.acos;
        const color = acos === null ? 'text-gray-400' :
          acos < 9 ? 'text-green-400' :
          acos < 15 ? 'text-yellow-400' :
          'text-red-400';
        return <span className={cn('font-mono', color)}>{formatAcos(acos)}</span>;
      },
    },
    {
      key: 'impressions',
      header: 'Impr.',
      sortable: true,
      className: 'text-right',
      render: (value: unknown, row: Keyword) => formatNumber(row.impressions),
    },
    {
      key: 'clicks',
      header: 'Clicks',
      sortable: true,
      className: 'text-right',
      render: (value: unknown, row: Keyword) => formatNumber(row.clicks),
    },
    {
      key: 'orders',
      header: 'Orders',
      sortable: true,
      className: 'text-right',
      render: (value: unknown, row: Keyword) => formatNumber(row.orders),
    },
    {
      key: 'actions',
      header: 'Lock',
      render: (value: unknown, row: Keyword) => (
        <div className="flex items-center gap-1">
          {row.is_locked ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleUnlock(row);
              }}
              disabled={unlockMutation.isPending}
              className="p-1.5 text-amber-500 dark:text-amber-400 hover:bg-amber-500/20 rounded transition-colors"
              title="Unlock keyword for AI changes"
            >
              <Unlock className="w-4 h-4" />
            </button>
          ) : (
            <div className="relative">
              {lockingKeyword === row.keyword_id ? (
                <div className="flex items-center gap-1">
                  {[3, 7, 14].map((days) => (
                    <button
                      key={days}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleLock(row, days);
                      }}
                      className="px-2 py-1 text-xs bg-gray-200 dark:bg-gray-700 rounded hover:bg-amber-500/20 text-gray-700 dark:text-gray-300 hover:text-amber-600 dark:hover:text-amber-400"
                    >
                      {days}d
                    </button>
                  ))}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setLockingKeyword(null);
                    }}
                    className="p-1 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setLockingKeyword(row.keyword_id);
                  }}
                  className="p-1.5 text-gray-600 dark:text-gray-300 hover:text-amber-500 dark:hover:text-amber-400 hover:bg-amber-500/20 rounded transition-colors"
                  title="Lock keyword from AI changes"
                >
                  <Lock className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
        </div>
      ),
    },
  ];

  // Calculate locked count
  const lockedCount = keywords?.filter(k => k.is_locked).length || 0;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Keywords & Targeting</h1>
          <p className="text-gray-400 mt-1">
            Manage keyword bids, view AI suggestions, and lock keywords from changes
          </p>
        </div>
        <div className="flex items-center gap-3">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          <button
            onClick={() => refetch()}
            className="btn btn-secondary"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              <select
                value={matchTypeFilter}
                onChange={(e) => setMatchTypeFilter(e.target.value)}
                className="select"
              >
                <option value="all">All Match Types</option>
                <option value="exact">Exact</option>
                <option value="phrase">Phrase</option>
                <option value="broad">Broad</option>
              </select>
            </div>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="select"
            >
              <option value="all">All States</option>
              <option value="enabled">Enabled</option>
              <option value="paused">Paused</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-secondary" onClick={handleExport} disabled={exporting}>
              {exporting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {exporting ? 'Exporting...' : 'Export'}
            </button>
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 stagger-animation">
        <div className="card p-4 hover-lift">
          <p className="text-sm text-gray-600 dark:text-gray-400">Total Keywords</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1 tabular-nums">
            {keywordsResponse?.total ?? 0}
          </p>
        </div>
        <div className="card p-4 hover-lift">
          <p className="text-sm text-gray-600 dark:text-gray-400">With AI Suggestions</p>
          <p className="text-2xl font-bold text-amazon-orange mt-1 tabular-nums">
            {keywords?.filter((k) => k.ai_suggested_bid).length || 0}
          </p>
        </div>
        <div className="card p-4 hover-lift">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-amber-400" />
            <p className="text-sm text-gray-400">Locked</p>
          </div>
          <p className="text-2xl font-bold text-amber-400 mt-1 tabular-nums">
            {lockedCount}
          </p>
        </div>
        <div className="card p-4 hover-lift">
          <p className="text-sm text-gray-400">Avg. Bid</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1 tabular-nums">
            {formatCurrency(
              keywords?.length
                ? keywords.reduce((sum, k) => sum + k.bid, 0) / keywords.length
                : 0
            )}
          </p>
        </div>
        <div className="card p-4 hover-lift">
          <p className="text-sm text-gray-400">Total Spend</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1 tabular-nums">
            {formatCurrency(keywords?.reduce((sum, k) => sum + k.spend, 0) || 0)}
          </p>
        </div>
      </div>

      {/* Lock Info Banner */}
      {lockedCount > 0 && (
        <div className="alert alert-warning">
          <Lock className="w-5 h-5" />
          <span>
            {lockedCount} keyword{lockedCount !== 1 ? 's are' : ' is'} locked from AI bid changes. 
            Locked keywords maintain their current bids until unlocked.
          </span>
        </div>
      )}

      {/* Data Table */}
      <SmartGrid
        data={filteredKeywords || []}
        columns={columns}
        keyField="keyword_id"
        loading={isLoading}
        emptyMessage="No keywords found"
        className="[&_tbody_tr]:group"
        pagination={
          keywordsResponse
            ? {
                page: keywordsResponse.page,
                pageSize: keywordsResponse.page_size,
                total: keywordsResponse.total,
                totalPages: keywordsResponse.total_pages,
              }
            : undefined
        }
        onPageChange={setPage}
        onPageSizeChange={(newSize) => {
          setPageSize(newSize);
          setPage(1);
        }}
        sort={sort}
        onSortChange={(key, direction) => {
          setSort({ sortKey: key, sortDirection: direction });
          setPage(1);
        }}
        onCellEdit={async (row, column, newValue) => {
          if (column === 'bid') {
            await updateKeywordBid((row as Keyword).keyword_id, {
              new_value: parseFloat(newValue),
              old_value: (row as Keyword).bid,
            });
            queryClient.invalidateQueries({ queryKey: ['keywords'] });
          }
        }}
      />
    </div>
  );
}
