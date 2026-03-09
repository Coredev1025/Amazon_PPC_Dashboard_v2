'use client';

import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { 
  Check, X, Edit2, Save, Columns, Filter, 
  Play, Pause, Archive, TrendingUp, TrendingDown, DollarSign,
  Percent, Package, Target, ChevronDown, XCircle, ChevronUp, ChevronsUpDown,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight
} from 'lucide-react';
import { Sparkline } from './Charts';
import { cn, formatCurrency, formatAcos } from '@/utils/helpers';
import { useToast } from '@/contexts/ToastContext';

interface Column<T> {
  key: keyof T | string;
  header: string;
  width?: number;
  sortable?: boolean;
  editable?: boolean;
  filterable?: boolean;
  filterType?: 'number' | 'text' | 'select';
  filterOptions?: string[];
  render?: (value: T[keyof T], row: T, isEditing: boolean, onSave: (value: any) => void) => React.ReactNode;
  className?: string;
  showSparkline?: boolean;
  sparklineData?: (row: T) => number[];
  editType?: 'text' | 'number' | 'currency' | 'status';
  statusOptions?: { value: string; label: string }[];
}

interface SmartGridProps<T extends Record<string, unknown>> {
  data: T[];
  columns: Column<T>[];
  keyField: keyof T;
  onRowClick?: (row: T) => void;
  selectedRows?: Set<string | number>;
  onSelectRow?: (id: string | number) => void;
  onSelectAllRows?: (ids: (string | number)[], select: boolean) => void;
  enableSelection?: boolean;
  loading?: boolean;
  emptyMessage?: string;
  className?: string;
  onCellEdit?: (row: T, column: string, newValue: any) => Promise<void>;
  onBulkAction?: (action: string, selectedIds: (string | number)[], params?: any) => Promise<void>;
  columnLayout?: {
    visibility: Record<string, boolean>;
    order: string[];
    widths: Record<string, number>;
  };
  onColumnLayoutChange?: (layout: {
    visibility: Record<string, boolean>;
    order: string[];
    widths: Record<string, number>;
  }) => void;
  statusFilter?: string;
  onStatusFilterChange?: (status: string) => void;
  statusFilterOptions?: { value: string; label: string }[];
  onSaveColumnLayout?: (layout: {
    visibility: Record<string, boolean>;
    order: string[];
    widths: Record<string, number>;
  }) => Promise<void>;
  // Server-side pagination
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  /** When true, table has no horizontal scroll (no scrollbar, content can wrap/overflow naturally) */
  disableTableScroll?: boolean;
  /** Server-side sort: controlled sort state and callback. When set, grid does not sort locally. */
  sort?: { sortKey: string; sortDirection: 'asc' | 'desc' } | null;
  onSortChange?: (key: string, direction: 'asc' | 'desc') => void;
}

export default function SmartGrid<T extends Record<string, unknown>>({
  data,
  columns,
  keyField,
  onRowClick,
  selectedRows = new Set(),
  onSelectRow,
  onSelectAllRows,
  enableSelection = false,
  loading = false,
  emptyMessage = 'No data available',
  className,
  onCellEdit,
  onBulkAction,
  columnLayout,
  onColumnLayoutChange,
  statusFilter = 'all',
  onStatusFilterChange,
  statusFilterOptions = [
    { value: 'all', label: 'All Status' },
    { value: 'enabled', label: 'Enabled' },
    { value: 'paused', label: 'Paused' },
    { value: 'archived', label: 'Archived' },
    { value: 'incomplete', label: 'Incomplete' },
    { value: 'out_of_budget', label: 'Out of Budget' },
  ],
  onSaveColumnLayout,
  pagination,
  onPageChange,
  onPageSizeChange,
  disableTableScroll = false,
  sort: controlledSort = null,
  onSortChange: onSortChangeProp = undefined,
}: SmartGridProps<T>) {
  const gridToast = useToast();
  const [editingCell, setEditingCell] = useState<{ rowId: string | number; column: string } | null>(null);
  const [editValue, setEditValue] = useState<any>('');
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  // When we have server-side pagination and onSortChange, always use server-side sort so sort applies to full dataset
  const serverSideSort = Boolean(pagination && onSortChangeProp);
  const effectiveSort = serverSideSort ? (controlledSort ?? sortConfig) : sortConfig;
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null);
  const [resizingColumn, setResizingColumn] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  const [columnOrder, setColumnOrder] = useState<string[]>(columns.map(c => String(c.key)));
  const [columnFilters, setColumnFilters] = useState<Record<string, { type: string; value: any; operator?: string }>>({});
  const [showFilterMenu, setShowFilterMenu] = useState<string | null>(null);
  const [showBulkActionMenu, setShowBulkActionMenu] = useState(false);
  const [pageInputValue, setPageInputValue] = useState<string>(String(pagination?.page ?? 1));
  const pageInputFocused = useRef(false);
  const [bulkActionParams, setBulkActionParams] = useState<any>({});
  const [bulkActionConfirmation, setBulkActionConfirmation] = useState<{ 
    action: string; 
    count: number; 
    details?: string;
    onConfirm?: () => void;
  } | null>(null);
  const [bulkActionInProgress, setBulkActionInProgress] = useState(false);
  const [promptDialog, setPromptDialog] = useState<{
    title: string;
    label: string;
    placeholder: string;
    defaultValue: string;
    inputType?: string;
    options?: { value: string; label: string }[];
    onSubmit: (value: string) => void;
  } | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const promptInputRef = useRef<HTMLInputElement>(null);
  const statusFilterScrollRef = useRef<number | null>(null);
  const pageSizeScrollRef = useRef<number | null>(null);

  useEffect(() => {
    if (!pageInputFocused.current && pagination) {
      setPageInputValue(String(pagination.page));
    }
  }, [pagination?.page]);

  const getMainScrollTop = () => {
    const main = document.querySelector('main');
    const scrollEl = main?.children[1] as HTMLElement | undefined;
    return scrollEl ? scrollEl.scrollTop : (typeof window !== 'undefined' ? window.scrollY : 0);
  };
  const setMainScrollTop = (top: number) => {
    const main = document.querySelector('main');
    const scrollEl = main?.children[1] as HTMLElement | undefined;
    if (scrollEl) scrollEl.scrollTop = top;
    else if (typeof window !== 'undefined') window.scrollTo(0, top);
  };
  const restoreScrollAfterUpdate = (saved: number | null) => {
    if (saved == null) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setMainScrollTop(saved));
    });
  };

  const openPromptDialog = (opts: {
    title: string;
    label: string;
    placeholder?: string;
    defaultValue?: string;
    inputType?: string;
    options?: { value: string; label: string }[];
    onSubmit: (value: string) => void;
  }) => {
    const val = opts.defaultValue || '';
    setPromptValue(val);
    setPromptDialog({
      title: opts.title,
      label: opts.label,
      placeholder: opts.placeholder || '',
      defaultValue: val,
      inputType: opts.inputType,
      options: opts.options,
      onSubmit: opts.onSubmit,
    });
    setTimeout(() => promptInputRef.current?.focus(), 50);
  };

  const inputRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const tableScrollContainerRef = useRef<HTMLDivElement>(null);
  const topScrollBarRef = useRef<HTMLDivElement>(null);
  const topScrollSpacerRef = useRef<HTMLDivElement>(null);
  const isSyncingScroll = useRef(false);

  useLayoutEffect(() => {
    const container = tableScrollContainerRef.current;
    const spacer = topScrollSpacerRef.current;
    if (container && spacer) {
      spacer.style.width = `${container.scrollWidth}px`;
    }
  });

  const syncScrollFromTable = () => {
    if (isSyncingScroll.current) return;
    const container = tableScrollContainerRef.current;
    const top = topScrollBarRef.current;
    if (container && top) {
      isSyncingScroll.current = true;
      top.scrollLeft = container.scrollLeft;
      requestAnimationFrame(() => { isSyncingScroll.current = false; });
    }
  };

  const syncScrollFromTop = () => {
    if (isSyncingScroll.current) return;
    const container = tableScrollContainerRef.current;
    const top = topScrollBarRef.current;
    if (container && top) {
      isSyncingScroll.current = true;
      container.scrollLeft = top.scrollLeft;
      requestAnimationFrame(() => { isSyncingScroll.current = false; });
    }
  };

  // Generate a unique key for localStorage based on columns
  const gridLayoutKey = `smartgrid_layout_${columns.map(c => String(c.key)).join('_')}`;

  // Initialize from props or defaults
  useEffect(() => {
    if (columnLayout) {
      setColumnVisibility(columnLayout.visibility);
      setColumnOrder(columnLayout.order.length > 0 ? columnLayout.order : columns.map(c => String(c.key)));
      setColumnWidths(columnLayout.widths);
    } else {
      // Try to load from localStorage first
      try {
        const savedLayout = localStorage.getItem(gridLayoutKey);
        if (savedLayout) {
          const parsed = JSON.parse(savedLayout);
          setColumnVisibility(parsed.visibility || columns.reduce((acc, col) => ({ ...acc, [String(col.key)]: true }), {}));
          setColumnOrder(parsed.order?.length > 0 ? parsed.order : columns.map(c => String(c.key)));
          setColumnWidths(parsed.widths || columns.reduce((acc, col) => ({ ...acc, [String(col.key)]: col.width || 200 }), {}));
          return;
        }
      } catch (e) {
        console.warn('Failed to load column layout from localStorage:', e);
      }
      
      // Default initialization
      setColumnVisibility(columns.reduce((acc, col) => ({ ...acc, [String(col.key)]: true }), {}));
      setColumnOrder(columns.map(c => String(c.key)));
      setColumnWidths(columns.reduce((acc, col) => ({ ...acc, [String(col.key)]: col.width || 200 }), {}));
    }
  }, [columns, columnLayout, gridLayoutKey]);

  // Save layout changes
  useEffect(() => {
    if (onColumnLayoutChange) {
      const layout = {
        visibility: columnVisibility,
        order: columnOrder,
        widths: columnWidths,
      };
      onColumnLayoutChange(layout);
      
      // Persist to localStorage
      try {
        localStorage.setItem(gridLayoutKey, JSON.stringify(layout));
      } catch (e) {
        console.warn('Failed to save column layout to localStorage:', e);
      }
      
      // Persist to user profile if callback provided
      if (onSaveColumnLayout) {
        onSaveColumnLayout(layout).catch(err => {
          console.error('Failed to save column layout:', err);
        });
      }
    }
  }, [columnVisibility, columnOrder, columnWidths, onColumnLayoutChange, onSaveColumnLayout, gridLayoutKey]);

  // Close filter menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (filterMenuRef.current && !filterMenuRef.current.contains(event.target as Node)) {
        setShowFilterMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSort = (key: string) => {
    const currentKey = effectiveSort && ('sortKey' in effectiveSort ? effectiveSort.sortKey : effectiveSort.key);
    const currentDir = effectiveSort && ('sortDirection' in effectiveSort ? effectiveSort.sortDirection : effectiveSort.direction);
    const direction: 'asc' | 'desc' = (currentKey === key && currentDir === 'asc') ? 'desc' : 'asc';
    if (serverSideSort && onSortChangeProp) {
      onSortChangeProp(key, direction);
    } else {
      setSortConfig({ key, direction });
    }
  };

  // Apply filters to data
  const filteredData = useMemo(() => {
    let result = [...data];

    // Apply status filter
    if (statusFilter !== 'all' && onStatusFilterChange) {
      result = result.filter(row => {
        const status = (row as any).status || (row as any).state;
        return status?.toLowerCase() === statusFilter.toLowerCase();
      });
    }

    // Apply column filters
    Object.entries(columnFilters).forEach(([columnKey, filter]) => {
      if (!filter.value) return;
      
      result = result.filter(row => {
        const value = row[columnKey as keyof T];
        if (value === null || value === undefined) return false;

        if (filter.type === 'number') {
          const numValue = typeof value === 'number' ? value : parseFloat(String(value));
          const filterNum = parseFloat(filter.value);
          
          if (filter.operator === '>') return numValue > filterNum;
          if (filter.operator === '<') return numValue < filterNum;
          if (filter.operator === '>=') return numValue >= filterNum;
          if (filter.operator === '<=') return numValue <= filterNum;
          if (filter.operator === '=') return numValue === filterNum;
          return true;
        } else if (filter.type === 'text') {
          return String(value).toLowerCase().includes(String(filter.value).toLowerCase());
        } else if (filter.type === 'select') {
          return String(value) === String(filter.value);
        }

        return String(value) === String(filter.value);
      });
    });

    return result;
  }, [data, statusFilter, columnFilters, onStatusFilterChange]);

  const sortedData = useMemo(() => {
    if (serverSideSort) return filteredData;
    const config = sortConfig;
    if (!config) return filteredData;

    return [...filteredData].sort((a, b) => {
      const aVal = a[config.key as keyof T];
      const bVal = b[config.key as keyof T];

      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return config.direction === 'asc' ? aVal - bVal : bVal - aVal;
      }

      const aStr = String(aVal);
      const bStr = String(bVal);
      return config.direction === 'asc'
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });
  }, [filteredData, sortConfig, serverSideSort]);

  const handleCellClick = (row: T, column: Column<T>) => {
    // Prevent editing if item is out of stock (bidding protection)
    const inventoryStatus = (row as any).inventory_status;
    if (inventoryStatus === 'out_of_stock' && (String(column.key) === 'bid' || String(column.key) === 'bid_price')) {
      console.warn('Cannot edit bid for out-of-stock product');
      return;
    }
    
    if (!column.editable || !onCellEdit) return;
    
    const rowId = String(row[keyField]);
    setEditingCell({ rowId, column: String(column.key) });
    
    // Initialize edit value based on type
    const rawValue = row[column.key as keyof T];
    if (column.editType === 'currency' && typeof rawValue === 'number') {
      setEditValue(rawValue.toFixed(2));
    } else {
      setEditValue(rawValue);
    }
  };

  const handleCellSave = async () => {
    if (!editingCell || !onCellEdit) return;

    const row = data.find(r => String(r[keyField]) === editingCell.rowId);
    if (row) {
      try {
        let finalValue = editValue;
        
        // Convert based on edit type
        const column = columns.find(c => String(c.key) === editingCell.column);
        if (column?.editType === 'currency' || column?.editType === 'number') {
          finalValue = parseFloat(editValue) || 0;
        }
        
        await onCellEdit(row, editingCell.column, finalValue);
        setEditingCell(null);
        setEditValue('');
      } catch (error) {
        console.error('Failed to save cell:', error);
        // Keep editing state on error so user can retry
      }
    }
  };

  const handleCellCancel = () => {
    setEditingCell(null);
    setEditValue('');
  };

  const handleStatusToggle = async (row: T, newStatus: string) => {
    if (!onCellEdit) return;
    
    try {
      await onCellEdit(row, 'status', newStatus);
    } catch (error) {
      console.error('Failed to update status:', error);
    }
  };

  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingCell]);

  const toggleColumnVisibility = (columnKey: string) => {
    setColumnVisibility(prev => ({
      ...prev,
      [columnKey]: !prev[columnKey],
    }));
  };

  const handleColumnDragStart = (columnKey: string) => {
    setDraggedColumn(columnKey);
  };

  const handleColumnDrop = (targetColumnKey: string) => {
    if (!draggedColumn || draggedColumn === targetColumnKey) return;

    const newOrder = [...columnOrder];
    const draggedIndex = newOrder.indexOf(draggedColumn);
    const targetIndex = newOrder.indexOf(targetColumnKey);

    newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, draggedColumn);

    setColumnOrder(newOrder);
    setDraggedColumn(null);
  };

  const handleColumnResize = (columnKey: string, newWidth: number) => {
    setColumnWidths(prev => ({
      ...prev,
      [columnKey]: Math.max(100, newWidth),
    }));
  };

  const handleFilterChange = (columnKey: string, filter: { type: string; value: any; operator?: string }) => {
    setColumnFilters(prev => {
      if (!filter.value) {
        const newFilters = { ...prev };
        delete newFilters[columnKey];
        return newFilters;
      }
      return { ...prev, [columnKey]: filter };
    });
    setShowFilterMenu(null);
  };

  const clearFilter = (columnKey: string) => {
    setColumnFilters(prev => {
      const newFilters = { ...prev };
      delete newFilters[columnKey];
      return newFilters;
    });
  };

  // Get visible and ordered columns
  const visibleColumns = columnOrder
    .map(key => columns.find(c => String(c.key) === key))
    .filter((col): col is Column<T> => col !== undefined && columnVisibility[String(col.key)] !== false);

  // Normalize selectedRows to strings for consistent comparison
  // This fixes the type mismatch where parent passes number IDs but SmartGrid uses String(row[keyField])
  const normalizedSelectedRows = useMemo(
    () => new Set(Array.from(selectedRows).map(String)),
    [selectedRows]
  );

  // Calculate selection state based on filtered/sorted data
  const selectableRowIds = new Set(sortedData.map(row => String(row[keyField])));
  const selectedCount = Array.from(normalizedSelectedRows).filter(id => selectableRowIds.has(id)).length;
  const allSelected = sortedData.length > 0 && selectedCount === sortedData.length && selectedCount > 0;
  const someSelected = selectedCount > 0 && selectedCount < sortedData.length;

  // Bulk action handlers
  const handleBulkAction = async (action: string, params?: any) => {
    if (!onBulkAction || normalizedSelectedRows.size === 0) return;
    
    const selectedIds = Array.from(normalizedSelectedRows);
    const actionDescriptions: Record<string, string> = {
      pause: 'Pause selected items',
      enable: 'Enable selected items',
      archive: 'Archive selected items',
      adjust_bids: `Adjust bids ${params?.type === 'increase' ? `by +${params?.percent}%` : params?.type === 'decrease' ? `by -${params?.percent}%` : `to $${params?.amount}`}`,
      adjust_budgets: `Adjust budgets by $${params?.amount}`,
      move_to_portfolio: `Move to portfolio ${params?.portfolioId}`,
    };

    // Check if any selected items are out of stock when trying to adjust bids
    let outOfStockWarning = '';
    if (action === 'adjust_bids') {
      const outOfStockItems = selectedIds.filter(id => {
        const row = data.find(r => String(r[keyField]) === id);
        return (row as any)?.inventory_status === 'out_of_stock';
      });
      
      if (outOfStockItems.length > 0) {
        outOfStockWarning = `⚠️ ${outOfStockItems.length} item(s) are out of stock. Bidding wastes budget.`;
      }
    }

    // Show confirmation modal
    setBulkActionConfirmation({
      action: action,
      count: selectedIds.length,
      details: outOfStockWarning,
      onConfirm: async () => {
        setBulkActionInProgress(true);
        try {
          await onBulkAction(action, selectedIds, params);
          setShowBulkActionMenu(false);
          setBulkActionParams({});
          setBulkActionConfirmation(null);
        } catch (error) {
          console.error('Bulk action failed:', error);
          gridToast.error('Bulk Action Failed', `Failed to ${action}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
          setBulkActionInProgress(false);
        }
      }
    });
  };

  if (loading) {
    return (
      <div className={cn('card overflow-hidden', className)}>
        <div className="animate-pulse p-8">
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-4" />
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-4 bg-gray-200 dark:bg-gray-700 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-4 relative', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Status Filter */}
          {onStatusFilterChange && (
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-400" />
              <select
                value={statusFilter}
                onFocus={() => { statusFilterScrollRef.current = getMainScrollTop(); }}
                onChange={(e) => {
                  const value = e.target.value;
                  onStatusFilterChange(value);
                  const saved = statusFilterScrollRef.current;
                  statusFilterScrollRef.current = null;
                  restoreScrollAfterUpdate(saved);
                }}
                className="select text-sm"
              >
                {statusFilterOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowColumnPicker(!showColumnPicker)}
            className="btn btn-sm btn-secondary"
          >
            <Columns className="w-4 h-4" />
            Columns
          </button>
        </div>
      </div>

      {/* Column Picker */}
      {showColumnPicker && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold mb-3">Column Visibility</h3>
          <div className="space-y-2">
            {columns.map(column => (
              <label key={String(column.key)} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={columnVisibility[String(column.key)] !== false}
                  onChange={() => toggleColumnVisibility(String(column.key))}
                  className="rounded accent-amazon-orange"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">{column.header}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Floating Action Bar */}
      {enableSelection && normalizedSelectedRows.size > 0 && (
        <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-50">
          <div className="card p-4 shadow-2xl border-2 border-amazon-orange/20 bg-white dark:bg-gray-800">
            <div className="flex items-center gap-4">
              <span className="text-sm font-semibold text-gray-900 dark:text-white">
                {normalizedSelectedRows.size} selected
              </span>
              <div className="flex items-center gap-2 border-l border-gray-200 dark:border-gray-700 pl-4">
                <button
                  onClick={() => handleBulkAction('pause')}
                  className="btn btn-sm btn-secondary flex items-center gap-1"
                >
                  <Pause className="w-3 h-3" />
                  Pause
                </button>
                <button
                  onClick={() => handleBulkAction('enable')}
                  className="btn btn-sm btn-secondary flex items-center gap-1"
                >
                  <Play className="w-3 h-3" />
                  Enable
                </button>
                <button
                  onClick={() => handleBulkAction('archive')}
                  className="btn btn-sm btn-secondary flex items-center gap-1"
                >
                  <Archive className="w-3 h-3" />
                  Archive
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowBulkActionMenu(!showBulkActionMenu)}
                    className="btn btn-sm btn-secondary flex items-center gap-1"
                  >
                    <DollarSign className="w-3 h-3" />
                    Adjust Bids
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {showBulkActionMenu && (
                    <div className="absolute bottom-full mb-2 left-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2 min-w-[200px]">
                      <div className="space-y-2">
                        <button
                          onClick={() => {
                            setShowBulkActionMenu(false);
                            openPromptDialog({
                              title: 'Increase Bids',
                              label: 'Increase by percentage (%)',
                              placeholder: '10',
                              defaultValue: '10',
                              inputType: 'number',
                              onSubmit: (val) => handleBulkAction('adjust_bids', { type: 'increase', percent: parseFloat(val) }),
                            });
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 rounded flex items-center gap-2"
                        >
                          <TrendingUp className="w-4 h-4" />
                          Increase by %
                        </button>
                        <button
                          onClick={() => {
                            setShowBulkActionMenu(false);
                            openPromptDialog({
                              title: 'Decrease Bids',
                              label: 'Decrease by percentage (%)',
                              placeholder: '10',
                              defaultValue: '10',
                              inputType: 'number',
                              onSubmit: (val) => handleBulkAction('adjust_bids', { type: 'decrease', percent: parseFloat(val) }),
                            });
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 rounded flex items-center gap-2"
                        >
                          <TrendingDown className="w-4 h-4" />
                          Decrease by %
                        </button>
                        <button
                          onClick={() => {
                            setShowBulkActionMenu(false);
                            openPromptDialog({
                              title: 'Set Bid',
                              label: 'Set bid amount ($)',
                              placeholder: '0.75',
                              defaultValue: '',
                              inputType: 'number',
                              onSubmit: (val) => handleBulkAction('adjust_bids', { type: 'set', amount: parseFloat(val) }),
                            });
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 rounded flex items-center gap-2"
                        >
                          <DollarSign className="w-4 h-4" />
                          Set to $
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => {
                    openPromptDialog({
                      title: 'Adjust Budgets',
                      label: 'Adjust daily budgets by amount ($)',
                      placeholder: '5.00',
                      defaultValue: '',
                      inputType: 'number',
                      onSubmit: (val) => handleBulkAction('adjust_budgets', { amount: parseFloat(val) }),
                    });
                  }}
                  className="btn btn-sm btn-secondary flex items-center gap-1"
                >
                  <DollarSign className="w-3 h-3" />
                  Adjust Budgets
                </button>
                <button
                  onClick={() => {
                    openPromptDialog({
                      title: 'Move to Portfolio',
                      label: 'Enter Portfolio ID',
                      placeholder: 'e.g. 12345',
                      defaultValue: '',
                      inputType: 'number',
                      onSubmit: (val) => handleBulkAction('move_to_portfolio', { portfolioId: parseInt(val) }),
                    });
                  }}
                  className="btn btn-sm btn-secondary flex items-center gap-1"
                >
                  <Package className="w-3 h-3" />
                  Move to Portfolio
                </button>
                <div className="relative">
                  <button
                    onClick={() => {
                      openPromptDialog({
                        title: 'Apply Bidding Strategy',
                        label: 'Select bidding strategy',
                        placeholder: '',
                        defaultValue: 'dynamic_down',
                        options: [
                          { value: 'dynamic_down', label: 'Dynamic Bids — Down Only' },
                          { value: 'up_and_down', label: 'Dynamic Bids — Up and Down' },
                          { value: 'fixed', label: 'Fixed Bids' },
                        ],
                        onSubmit: (val) => handleBulkAction('apply_bidding_strategy', { strategy: val }),
                      });
                    }}
                    className="btn btn-sm btn-secondary flex items-center gap-1"
                  >
                    <Target className="w-3 h-3" />
                    Bidding Strategy
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card overflow-hidden">
        <div
          ref={tableScrollContainerRef}
          onScroll={disableTableScroll ? undefined : syncScrollFromTable}
          className={disableTableScroll ? '' : 'overflow-x-auto pr-4 md:pr-6'}
        >
          <table ref={tableRef} className={cn('w-full border-collapse', !disableTableScroll && 'min-w-full table-fixed')}>
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                {enableSelection && (
                  <th className="px-3 py-3 text-left w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected && !allSelected;
                      }}
                      onChange={(e) => {
                        const shouldSelect = e.target.checked;
                        
                        // Collect all row IDs that need to be changed
                        const rowIdsToChange: (string | number)[] = [];
                        
                        sortedData.forEach(row => {
                          const rowId = String(row[keyField]);
                          const isCurrentlySelected = normalizedSelectedRows.has(rowId);
                          
                          // Collect IDs that need state change
                          if (shouldSelect && !isCurrentlySelected) {
                            rowIdsToChange.push(rowId);
                          } else if (!shouldSelect && isCurrentlySelected) {
                            rowIdsToChange.push(rowId);
                          }
                        });
                        
                        // Use batch selection if available
                        if (onSelectAllRows && rowIdsToChange.length > 0) {
                          // Batch operation - select/deselect all at once
                          onSelectAllRows(rowIdsToChange, shouldSelect);
                        } else if (onSelectRow && rowIdsToChange.length > 0) {
                          // Fallback: batch process all rows using React's automatic batching
                          // React 18+ automatically batches state updates in event handlers
                          // Process all selections in a single batch
                          rowIdsToChange.forEach((rowId) => {
                            onSelectRow(rowId);
                          });
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded accent-amazon-orange cursor-pointer"
                      title={allSelected ? "Deselect all" : "Select all"}
                    />
                  </th>
                )}
                {visibleColumns.map((column, index) => {
                  const columnKey = String(column.key);
                  const width = columnWidths[columnKey] || column.width || 200;
                  const hasFilter = columnFilters[columnKey];
                  const isLastColumn = index === visibleColumns.length - 1;
                  
                  return (
                    <th
                      key={columnKey}
                      className={cn(
                        'px-4 py-3 text-left text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider relative overflow-hidden',
                        column.className,
                        !isLastColumn && 'border-r border-gray-200 dark:border-gray-700'
                      )}
                      style={{ width: `${width}px`, minWidth: `${width}px` }}
                      draggable
                      onDragStart={() => handleColumnDragStart(columnKey)}
                      onDragOver={(e) => {
                        e.preventDefault();
                      }}
                      onDrop={() => handleColumnDrop(columnKey)}
                    >
                      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                        <button
                          onClick={() => column.sortable && handleSort(columnKey)}
                          className={cn(
                            'flex-1 min-w-0 text-left flex items-center gap-1 truncate',
                            column.sortable && 'hover:text-amazon-orange cursor-pointer'
                          )}
                        >
                          {column.header}
                          {column.sortable && (
                            <span className="text-gray-400">
                              {((effectiveSort as { key?: string; sortKey?: string })?.key ?? (effectiveSort as { sortKey?: string })?.sortKey) === columnKey ? (
                                ((effectiveSort as { direction?: string; sortDirection?: string })?.direction ?? (effectiveSort as { sortDirection?: string })?.sortDirection) === 'asc' ? (
                                  <ChevronUp className="w-3 h-3" />
                                ) : (
                                  <ChevronDown className="w-3 h-3" />
                                )
                              ) : (
                                <ChevronsUpDown className="w-3 h-3" />
                              )}
                            </span>
                          )}
                        </button>
                        {column.filterable && (
                          <div className="relative" ref={showFilterMenu === columnKey ? filterMenuRef : null}>
                            <button
                              onClick={() => setShowFilterMenu(showFilterMenu === columnKey ? null : columnKey)}
                              className={cn(
                                'p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700',
                                hasFilter && 'text-amazon-orange'
                              )}
                            >
                              <Filter className="w-3 h-3" />
                            </button>
                            {showFilterMenu === columnKey && (
                              <div className="absolute top-full right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 z-50 min-w-[200px]">
                                {column.filterType === 'number' ? (
                                  <div className="space-y-2">
                                    <select
                                      value={columnFilters[columnKey]?.operator || '>'}
                                      onChange={(e) => {
                                        const current = columnFilters[columnKey];
                                        handleFilterChange(columnKey, {
                                          type: 'number',
                                          operator: e.target.value,
                                          value: current?.value || '',
                                        });
                                      }}
                                      className="select text-sm w-full"
                                    >
                                      <option value=">">Greater than</option>
                                      <option value="<">Less than</option>
                                      <option value=">=">Greater or equal</option>
                                      <option value="<=">Less or equal</option>
                                      <option value="=">Equal to</option>
                                    </select>
                                    <input
                                      type="number"
                                      placeholder="Value"
                                      value={columnFilters[columnKey]?.value || ''}
                                      onChange={(e) => {
                                        handleFilterChange(columnKey, {
                                          type: 'number',
                                          operator: columnFilters[columnKey]?.operator || '>',
                                          value: e.target.value,
                                        });
                                      }}
                                      className="input text-sm w-full"
                                    />
                                  </div>
                                ) : column.filterType === 'select' ? (
                                  <select
                                    value={columnFilters[columnKey]?.value || ''}
                                    onChange={(e) => {
                                      handleFilterChange(columnKey, {
                                        type: 'select',
                                        value: e.target.value,
                                      });
                                    }}
                                    className="select text-sm w-full"
                                  >
                                    <option value="">All</option>
                                    {column.filterOptions?.map(opt => (
                                      <option key={opt} value={opt}>{opt}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    type="text"
                                    placeholder="Filter..."
                                    value={columnFilters[columnKey]?.value || ''}
                                    onChange={(e) => {
                                      handleFilterChange(columnKey, {
                                        type: 'text',
                                        value: e.target.value,
                                      });
                                    }}
                                    className="input text-sm w-full"
                                  />
                                )}
                                {hasFilter && (
                                  <button
                                    onClick={() => clearFilter(columnKey)}
                                    className="mt-2 text-xs text-red-600 hover:text-red-700 flex items-center gap-1"
                                  >
                                    <XCircle className="w-3 h-3" />
                                    Clear filter
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      {/* Resizable border - entire right border is draggable */}
                      {!isLastColumn && (
                        <div
                          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:w-1.5 hover:bg-amazon-orange transition-all"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setResizingColumn(columnKey);
                            const startX = e.clientX;
                            const startWidth = width;

                            const handleMouseMove = (e: MouseEvent) => {
                              const diff = e.clientX - startX;
                              handleColumnResize(columnKey, startWidth + diff);
                            };

                            const handleMouseUp = () => {
                              setResizingColumn(null);
                              document.removeEventListener('mousemove', handleMouseMove);
                              document.removeEventListener('mouseup', handleMouseUp);
                            };

                            document.addEventListener('mousemove', handleMouseMove);
                            document.addEventListener('mouseup', handleMouseUp);
                          }}
                          style={{ 
                            zIndex: 10,
                            userSelect: 'none',
                            marginRight: '-1px'
                          }}
                        />
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700 border-collapse">
              {sortedData.length === 0 ? (
                <tr>
                  <td
                    colSpan={visibleColumns.length + (enableSelection ? 1 : 0)}
                    className="px-4 py-12 text-center text-gray-500 dark:text-gray-400"
                  >
                    {emptyMessage}
                  </td>
                </tr>
              ) : (
                sortedData.map((row) => {
                  const rowId = String(row[keyField]);
                  const isEditing = editingCell?.rowId === rowId;

                  return (
                    <tr
                      key={rowId}
                      onClick={() => !isEditing && onRowClick?.(row)}
                      className={cn(
                        'hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group',
                        normalizedSelectedRows.has(rowId) && 'bg-amazon-orange/5',
                        isEditing && 'bg-blue-50 dark:bg-blue-900/20'
                      )}
                    >
                      {enableSelection && (
                        <td className="px-3 py-3 w-10">
                          <input
                            type="checkbox"
                            checked={normalizedSelectedRows.has(rowId)}
                            onChange={() => onSelectRow?.(rowId)}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded accent-amazon-orange"
                          />
                        </td>
                      )}
                      {visibleColumns.map((column, colIndex) => {
                        const columnKey = String(column.key);
                        const value = row[column.key as keyof T];
                        const isCellEditing = isEditing && editingCell?.column === columnKey;
                        const width = columnWidths[columnKey] || column.width || 200;
                        const isLastColumn = colIndex === visibleColumns.length - 1;

                        return (
                          <td
                            key={columnKey}
                            className={cn(
                              'px-4 py-3 relative overflow-hidden min-w-0',
                              column.className,
                              !isLastColumn && 'border-r border-gray-200 dark:border-gray-700'
                            )}
                            style={{ width: `${width}px`, minWidth: `${width}px` }}
                            onClick={() => column.editable && handleCellClick(row, column)}
                          >
                            {isCellEditing && column.editable ? (
                              <div className="flex items-center gap-2">
                                {column.editType === 'status' && column.statusOptions ? (
                                  <select
                                    ref={inputRef as any}
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        handleCellSave();
                                      } else if (e.key === 'Escape') {
                                        handleCellCancel();
                                      }
                                    }}
                                    className="select flex-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {column.statusOptions.map(opt => (
                                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    ref={inputRef}
                                    type={column.editType === 'currency' || column.editType === 'number' ? 'number' : 'text'}
                                    step={column.editType === 'currency' ? '0.01' : undefined}
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        handleCellSave();
                                      } else if (e.key === 'Escape') {
                                        handleCellCancel();
                                      }
                                    }}
                                    className="input flex-1"
                                    onClick={(e) => e.stopPropagation()}
                                    placeholder={column.editType === 'currency' ? '$0.00' : ''}
                                  />
                                )}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCellSave();
                                  }}
                                  className="p-1 text-green-600 hover:text-green-700"
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCellCancel();
                                  }}
                                  className="p-1 text-red-600 hover:text-red-700"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2">
                                {column.editType === 'status' && column.editable ? (
                                  <div className="flex items-center gap-2">
                                    <select
                                      value={String(value || '')}
                                      onChange={(e) => {
                                        e.stopPropagation();
                                        handleStatusToggle(row, e.target.value);
                                      }}
                                      className="select text-sm"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      {column.statusOptions?.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                      ))}
                                    </select>
                                  </div>
                                ) : column.render ? (
                                  column.render(value, row, false, () => {})
                                ) : (
                                  <span className="text-gray-900 dark:text-white">
                                    {column.editType === 'currency' && typeof value === 'number'
                                      ? formatCurrency(value)
                                      : String(value ?? '')}
                                  </span>
                                )}
                                {column.showSparkline && column.sparklineData && (
                                  <div className="ml-auto">
                                    <Sparkline
                                      data={column.sparklineData(row)}
                                      width={60}
                                      height={20}
                                    />
                                  </div>
                                )}
                                {column.editable && column.editType !== 'status' && (
                                  <Edit2 className="w-3 h-3 text-gray-400 opacity-0 group-hover:opacity-100 ml-auto" />
                                )}
                              </div>
                            )}
                            {/* Resizable border for cells - entire right border is draggable */}
                            {!isLastColumn && (
                              <div
                                className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:w-1.5 hover:bg-amazon-orange transition-all"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setResizingColumn(columnKey);
                                  const startX = e.clientX;
                                  const startWidth = width;

                                  const handleMouseMove = (e: MouseEvent) => {
                                    const diff = e.clientX - startX;
                                    handleColumnResize(columnKey, startWidth + diff);
                                  };

                                  const handleMouseUp = () => {
                                    setResizingColumn(null);
                                    document.removeEventListener('mousemove', handleMouseMove);
                                    document.removeEventListener('mouseup', handleMouseUp);
                                  };

                                  document.addEventListener('mousemove', handleMouseMove);
                                  document.addEventListener('mouseup', handleMouseUp);
                                }}
                                style={{ 
                                  zIndex: 10,
                                  userSelect: 'none',
                                  marginRight: '-1px'
                                }}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination Controls */}
      {pagination && pagination.totalPages > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30">
          {/* Left: Row info */}
          <div className="text-sm text-gray-600 dark:text-gray-400 tabular-nums">
            Showing{' '}
            <span className="font-medium text-gray-900 dark:text-white">
              {Math.min((pagination.page - 1) * pagination.pageSize + 1, pagination.total)}
            </span>
            {' '}-{' '}
            <span className="font-medium text-gray-900 dark:text-white">
              {Math.min(pagination.page * pagination.pageSize, pagination.total)}
            </span>
            {' '}of{' '}
            <span className="font-medium text-gray-900 dark:text-white">{pagination.total.toLocaleString()}</span>
            {' '}results
          </div>

          {/* Center: Page navigation */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPageChange?.(1)}
              disabled={pagination.page <= 1}
              className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="First page"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => onPageChange?.(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            {/* Editable page number */}
            <span className="text-sm text-gray-600 dark:text-gray-400 mx-1">Page</span>
            <input
              type="text"
              inputMode="numeric"
              value={pageInputValue}
              onFocus={(e) => {
                pageInputFocused.current = true;
                e.target.select();
              }}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9]/g, '');
                setPageInputValue(raw);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const v = parseInt(pageInputValue, 10);
                  if (!isNaN(v) && v >= 1 && v <= pagination.totalPages) {
                    onPageChange?.(v);
                  } else {
                    setPageInputValue(String(pagination.page));
                  }
                  pageInputFocused.current = false;
                  (e.target as HTMLInputElement).blur();
                }
              }}
              onBlur={() => {
                pageInputFocused.current = false;
                const v = parseInt(pageInputValue, 10);
                if (!isNaN(v) && v >= 1 && v <= pagination.totalPages) {
                  onPageChange?.(v);
                } else {
                  setPageInputValue(String(pagination.page));
                }
              }}
              className="w-14 h-8 px-2 text-sm text-center font-medium rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-amazon-orange/50 focus:border-amazon-orange transition-colors"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400 mx-1">of {pagination.totalPages}</span>

            <button
              onClick={() => onPageChange?.(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => onPageChange?.(pagination.totalPages)}
              disabled={pagination.page >= pagination.totalPages}
              className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Last page"
            >
              <ChevronsRight className="w-4 h-4" />
            </button>
          </div>

          {/* Right: Page size selector */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">Rows:</span>
            <select
              value={pagination.pageSize}
              onFocus={() => { pageSizeScrollRef.current = getMainScrollTop(); }}
              onChange={(e) => {
                const size = Number(e.target.value);
                onPageSizeChange?.(size);
                const saved = pageSizeScrollRef.current;
                pageSizeScrollRef.current = null;
                restoreScrollAfterUpdate(saved);
              }}
              className="px-2 py-1 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-amazon-orange/50 focus:border-amazon-orange transition-colors"
            >
              {[5, 10, 25, 50, 100].map(size => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Bulk Action Confirmation Modal */}
      {bulkActionConfirmation && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setBulkActionConfirmation(null)}>
          <div className="card max-w-md w-full p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
              Confirm Bulk Action
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              You are about to <span className="font-medium">{bulkActionConfirmation.action}</span> {bulkActionConfirmation.count} item(s).
            </p>
            {bulkActionConfirmation.details && (
              <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded p-3 mb-4 text-sm text-orange-800 dark:text-orange-200">
                {bulkActionConfirmation.details}
              </div>
            )}
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              This action cannot be undone. Are you sure?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setBulkActionConfirmation(null)}
                disabled={bulkActionInProgress}
                className="btn btn-sm btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={() => bulkActionConfirmation.onConfirm?.()}
                disabled={bulkActionInProgress}
                className="btn btn-sm btn-primary flex items-center gap-2"
              >
                {bulkActionInProgress && <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt Input Dialog — replaces browser prompt() */}
      {promptDialog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setPromptDialog(null)}>
          <div
            className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 max-w-sm w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              {promptDialog.title}
            </h3>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {promptDialog.label}
            </label>
            {promptDialog.options ? (
              <select
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                className="w-full px-4 py-2.5 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amazon-orange/50 focus:border-amazon-orange transition-all"
              >
                {promptDialog.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                ref={promptInputRef}
                type={promptDialog.inputType || 'text'}
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                placeholder={promptDialog.placeholder}
                step={promptDialog.inputType === 'number' ? 'any' : undefined}
                className="w-full px-4 py-2.5 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amazon-orange/50 focus:border-amazon-orange transition-all"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && promptValue.trim()) {
                    promptDialog.onSubmit(promptValue.trim());
                    setPromptDialog(null);
                  } else if (e.key === 'Escape') {
                    setPromptDialog(null);
                  }
                }}
                autoFocus
              />
            )}
            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={() => setPromptDialog(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (promptValue.trim()) {
                    promptDialog.onSubmit(promptValue.trim());
                    setPromptDialog(null);
                  }
                }}
                disabled={!promptValue.trim()}
                className="px-4 py-2 text-sm font-medium text-black bg-amazon-orange hover:bg-amazon-orange-dark disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export type { Column };
