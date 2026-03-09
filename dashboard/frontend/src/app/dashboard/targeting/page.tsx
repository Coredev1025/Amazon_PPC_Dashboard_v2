'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Download,
  RefreshCw,
  AlertCircle,
  Target,
  Crosshair,
  Package,
  Tag,
} from 'lucide-react';
import SmartGrid, { type Column } from '@/components/SmartGrid';
import { fetchProductTargets, type ProductTarget } from '@/utils/api';
import {
  formatCurrency,
  formatAcos,
  formatRoas,
  formatNumber,
  formatPercentage,
  cn,
} from '@/utils/helpers';

interface ProductTargetingExtended extends ProductTarget {
  targetingTypeBadge?: string;
  profitability?: 'profitable' | 'breakeven' | 'unprofitable';
}

const DAYS = 7;

export default function ProductTargetingPage() {
  const [targetingTypeFilter, setTargetingTypeFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [selectedRows, setSelectedRows] = useState<Set<string | number>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);
  const [sort, setSort] = useState<{ sortKey: string; sortDirection: 'asc' | 'desc' } | null>(null);

  const queryClient = useQueryClient();

  const { data: targetingResponse, isLoading, refetch } = useQuery({
    queryKey: ['product-targets', targetingTypeFilter, stateFilter, page, pageSize, sort?.sortKey ?? null, sort?.sortDirection ?? null],
    queryFn: async () => {
      const res = await fetchProductTargets({
        days: DAYS,
        targeting_type: targetingTypeFilter !== 'all' ? targetingTypeFilter as 'asin' | 'category' | 'brand' : undefined,
        state: stateFilter !== 'all' ? stateFilter : undefined,
        page,
        page_size: pageSize,
        sort_by: sort?.sortKey,
        sort_order: sort?.sortDirection,
      });
      return {
        ...res,
        data: res.data.map((target: ProductTarget) => ({
          ...target,
          targetingTypeBadge: getTargetingTypeBadge(target.targeting_type),
          profitability: calculateProfitability(target.acos ?? 0, 0.09), // Default 9% target ACOS
        })),
      };
    },
  });

  const targets = targetingResponse?.data ?? [];

  const emptyOrDash = (v: unknown): string => {
    if (v === null || v === undefined) return '-';
    const s = String(v).trim();
    return s === '' ? '-' : s;
  };

  // Targeting type to UI badge mapping
  const getTargetingTypeBadge = (type: string): string => {
    const typeMap: Record<string, string> = {
      'asin': 'ASIN Targeting',
      'category': 'Category Targeting',
      'brand': 'Brand Targeting',
      'keyword': 'Keyword Targeting',
    };
    return typeMap[type] || type;
  };

  // Calculate profitability
  const calculateProfitability = (acos: number, targetAcos: number): 'profitable' | 'breakeven' | 'unprofitable' => {
    if (acos <= targetAcos * 0.8) return 'profitable';
    if (acos <= targetAcos * 1.2) return 'breakeven';
    return 'unprofitable';
  };

  // Grid columns configuration
  const columns: Column<ProductTargetingExtended>[] = [
    {
      key: 'targeting_id',
      header: 'Target ID',
      width: 160,
      sortable: true,
      render: (value: unknown) => <span className="font-mono whitespace-nowrap">{emptyOrDash(value)}</span>,
    },
    {
      key: 'targeting_value',
      header: 'Target Value',
      width: 200,
      sortable: true,
      render: (value: unknown, row: ProductTargetingExtended) => (
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate" title={emptyOrDash(value)}>{emptyOrDash(value)}</span>
          <span className={cn(
            'px-2 py-1 rounded text-xs font-semibold flex-shrink-0',
            row.targeting_type === 'asin' && 'bg-blue-500/20 text-blue-700 dark:text-blue-300',
            row.targeting_type === 'category' && 'bg-purple-500/20 text-purple-700 dark:text-purple-300',
            row.targeting_type === 'brand' && 'bg-green-500/20 text-green-700 dark:text-green-300',
          )}>
            {row.targetingTypeBadge}
          </span>
        </div>
      ),
    },
    {
      key: 'campaign_name',
      header: 'Campaign',
      width: 200,
      sortable: true,
      render: (value: unknown) => <span className="truncate block" title={emptyOrDash(value)}>{emptyOrDash(value)}</span>,
    },
    {
      key: 'ad_group_name',
      header: 'Ad Group',
      width: 180,
      sortable: true,
      render: (value: unknown) => <span className="truncate block" title={emptyOrDash(value)}>{emptyOrDash(value)}</span>,
    },
    {
      key: 'bid',
      header: 'Bid',
      width: 100,
      sortable: true,
      render: (value: unknown) => (
        <span className="font-mono">{value != null && value !== '' ? formatCurrency(Number(value)) : '-'}</span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      width: 100,
      sortable: true,
      render: (value: unknown) => {
        const state = emptyOrDash(value);
        if (state === '-') return <span className="text-gray-500">-</span>;
        const s = state.toLowerCase();
        return (
          <span className={cn(
            'px-2 py-1 rounded-full text-xs font-semibold',
            s === 'enabled' && 'bg-green-500/20 text-green-700 dark:text-green-300',
            s === 'paused' && 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300',
            s === 'archived' && 'bg-gray-500/20 text-gray-700 dark:text-gray-300',
          )}>
            {state.charAt(0).toUpperCase() + state.slice(1)}
          </span>
        );
      },
    },
    {
      key: 'impressions',
      header: 'Impressions',
      width: 120,
      sortable: true,
      render: (value: unknown) => <span>{value != null && value !== '' ? formatNumber(Number(value)) : '-'}</span>,
    },
    {
      key: 'clicks',
      header: 'Clicks',
      width: 100,
      sortable: true,
      render: (value: unknown) => <span>{value != null && value !== '' ? formatNumber(Number(value)) : '-'}</span>,
    },
    {
      key: 'spend',
      header: 'Spend',
      width: 120,
      sortable: true,
      render: (value: unknown) => (
        <span className="font-mono font-semibold">{value != null && value !== '' ? formatCurrency(Number(value)) : '-'}</span>
      ),
    },
    {
      key: 'sales',
      header: 'Sales',
      width: 120,
      sortable: true,
      render: (value: unknown) => (
        <span className="font-mono font-semibold">{value != null && value !== '' ? formatCurrency(Number(value)) : '-'}</span>
      ),
    },
    {
      key: 'acos',
      header: 'ACoS',
      width: 110,
      sortable: true,
      render: (value: unknown, row: ProductTargetingExtended) => {
        if (value == null || value === '' || (typeof value === 'number' && isNaN(value))) return <span>-</span>;
        const numValue = Number(value);
        const color = numValue < 9 ? 'text-green-600' : numValue > 15 ? 'text-red-600' : 'text-yellow-600';
        return <span className={cn('font-mono font-semibold', color)}>{formatAcos(numValue)}</span>;
      },
    },
    {
      key: 'roas',
      header: 'RoAS',
      width: 110,
      sortable: true,
      render: (value: unknown) => (
        <span className="font-mono">{value != null && value !== '' && !isNaN(Number(value)) ? formatRoas(Number(value)) : '-'}</span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-3 bg-amazon-orange/20 rounded-lg">
              <Crosshair className="w-6 h-6 text-amazon-orange" />
            </div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Product Targeting</h1>
          </div>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            Manage ASIN, Category, and Brand targeting for Sponsored Products
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="btn btn-secondary flex items-center gap-2"
          disabled={isLoading}
        >
          <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* Targeting Type Info */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 stagger-animation">
        <div className="card p-4 border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 hover-lift">
          <div className="flex items-center gap-2 mb-2">
            <Package className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h3 className="font-semibold text-gray-900 dark:text-white">ASIN Targeting</h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Target specific product ASINs to reach exact product audiences
          </p>
        </div>
        <div className="card p-4 border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/20 hover-lift">
          <div className="flex items-center gap-2 mb-2">
            <Tag className="w-5 h-5 text-purple-600 dark:text-purple-400" />
            <h3 className="font-semibold text-gray-900 dark:text-white">Category Targeting</h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Target product categories to reach buyers browsing specific categories
          </p>
        </div>
        <div className="card p-4 border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 hover-lift">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
            <h3 className="font-semibold text-gray-900 dark:text-white">Brand Targeting</h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Target competitors' or complementary brands to reach their customers
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Targeting Type</label>
            <select
              value={targetingTypeFilter}
              onChange={(e) => setTargetingTypeFilter(e.target.value)}
              className="input"
            >
              <option value="all">All Types</option>
              <option value="asin">ASIN Targeting</option>
              <option value="category">Category Targeting</option>
              <option value="brand">Brand Targeting</option>
            </select>
          </div>
          <div>
            <label className="label">State</label>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="input"
            >
              <option value="all">All States</option>
              <option value="enabled">Enabled</option>
              <option value="paused">Paused</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>
      </div>

      {/* Smart Grid */}
      <div className="card overflow-hidden">
        <SmartGrid<ProductTargetingExtended>
          data={targets}
          columns={columns}
          keyField="targeting_id"
          loading={isLoading}
          emptyMessage="No product targets found. Create some ASIN, Category, or Brand targets to get started."
          enableSelection={true}
          selectedRows={selectedRows}
          sort={sort}
          onSortChange={(key, direction) => {
            setSort({ sortKey: key, sortDirection: direction });
            setPage(1);
          }}
          pagination={targetingResponse ? {
            page: targetingResponse.page,
            pageSize: targetingResponse.page_size,
            total: targetingResponse.total,
            totalPages: targetingResponse.total_pages,
          } : undefined}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          onSelectRow={(id) => {
            const strId = String(id);
            const newSelected = new Set(selectedRows);
            if (newSelected.has(strId)) {
              newSelected.delete(strId);
            } else {
              newSelected.add(strId);
            }
            setSelectedRows(newSelected);
          }}
          onSelectAllRows={(ids, select) => {
            const newSelected = new Set(selectedRows);
            if (select) {
              ids.forEach(id => newSelected.add(String(id)));
            } else {
              ids.forEach(id => newSelected.delete(String(id)));
            }
            setSelectedRows(newSelected);
          }}
          onBulkAction={async (action, ids, params) => {
            console.log(`Bulk ${action} action for ${ids.length} targets`, params);
            // TODO: Implement bulk actions
          }}
          statusFilterOptions={[
            { value: 'all', label: 'All States' },
            { value: 'enabled', label: 'Enabled' },
            { value: 'paused', label: 'Paused' },
            { value: 'archived', label: 'Archived' },
          ]}
        />
      </div>
    </div>
  );
}
