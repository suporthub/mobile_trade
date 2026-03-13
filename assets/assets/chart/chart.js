

// Helper to get decimal precision from symbolGroupData (show_points)
window.getSymbolDecimals = function (symbol) {
    if (window.symbolGroupData) {
        const data = window.symbolGroupData.get(symbol);
        if (data && data.show_points !== undefined && data.show_points !== null) {
            return parseInt(data.show_points) || 5;
        }
    }
    return 5; // default fallback
};

// Global P&L calculation function for position lines
window.calculatePL = function (position, currentPrice) {
    if (!position) return '0.00';

    // If no current price, use pre-calculated P&L from Flutter
    if (!currentPrice || currentPrice <= 0) {
        const existingPnl = parseFloat(position.pnl);
        if (!isNaN(existingPnl)) {
            return existingPnl.toFixed(2);
        }
        return '0.00';
    }

    const entryPrice = parseFloat(position.order_price) || 0;
    const quantity = parseFloat(position.order_quantity) || 0;
    const type = (position.order_type || '').toUpperCase();

    if (entryPrice <= 0 || quantity <= 0) return '0.00';

    // Get contract value from position data (passed from Flutter) or default to 100000
    let contractValue = parseFloat(position.contract_value) || 100000;

    // Fallback: try to get from symbol data
    if (contractValue <= 0 && window.symbolGroupData) {
        const symbolData = window.symbolGroupData.get(position.order_company_name);
        if (symbolData && symbolData.contract_value) {
            contractValue = parseFloat(symbolData.contract_value);
        }
    }

    // Calculate P&L based on order type
    // BUY: profit when price goes up, SELL: profit when price goes down
    let pnl = 0;
    if (type === 'BUY') {
        pnl = (currentPrice - entryPrice) * contractValue * quantity;
    } else if (type === 'SELL') {
        pnl = (entryPrice - currentPrice) * contractValue * quantity;
    }

    return pnl.toFixed(2);
};

class TradingViewChart {
    constructor(containerId, symbol) {
        this.widget = null;
        this.containerId = containerId;
        this.currentSymbol = symbol;
        this.sellPriceLine = null;
        this.sellPriceInterval = null;
        this.lastSellPrice = null;
        this.positionLines = new Map();
        this.openPositions = [];
        this.init();
    }

    init() {
        if (typeof TradingView === 'undefined') {
            setTimeout(() => this.init(), 100);
            return;
        }
        this.createChart();
    }

    createChart() {
        // Use the bridge helper to get the theme (reads from appState or URL param)
        const savedTheme = window.getInitialTheme ? window.getInitialTheme() : (localStorage.getItem('flutter_theme') || 'light');
        const isWhite = savedTheme === 'light' || savedTheme === 'white';
        const tvTheme = isWhite ? 'light' : 'dark';
        const paneBg = isWhite ? '#ffffff' : '#131722';
        const gridColor = isWhite ? '#e4e7eb' : '#2a2e39';
        const textColor = isWhite ? '#000000' : '#787b86';

        this.widget = new TradingView.widget({
            debug: false,
            symbol: this.currentSymbol,
            datafeed: window.datafeed,
            interval: '30',
            container: this.containerId,
            library_path: './charting_library/',
            locale: 'en',
            disabled_features: [
                'use_localstorage_for_settings',
                'volume_force_overlay',
                'create_volume_indicator_by_default',
                'symbol_search_hot_key',
                'header_symbol_search',
                'header_compare'
            ],
            enabled_features: [
                'study_templates',
                'side_toolbar_in_fullscreen_mode',
                'header_in_fullscreen_mode',
                'items_favoriting',
                'save_chart_properties_to_local_storage',
                'dont_show_boolean_study_arguments',
                'hide_last_na_study_output',
                'drawing_templates',
                'left_toolbar'
            ],
            charts_storage_url: 'https://saveload.tradingview.com',
            charts_storage_api_version: '1.1',
            client_id: 'tradingview.com',
            user_id: 'public_user_id',
            fullscreen: false,
            autosize: true,
            theme: tvTheme,
            loading_screen: {
                backgroundColor: paneBg,
                foregroundColor: textColor
            },
            overrides: {
                'paneProperties.background': paneBg,
                'paneProperties.vertGridProperties.color': gridColor,
                'paneProperties.horzGridProperties.color': gridColor,
                'symbolWatermarkProperties.transparency': 90,
                'scalesProperties.textColor': textColor,
                'mainSeriesProperties.candleStyle.wickUpColor': '#26a69a',
                'mainSeriesProperties.candleStyle.wickDownColor': '#ef5350',
                'mainSeriesProperties.candleStyle.upColor': '#26a69a',
                'mainSeriesProperties.candleStyle.downColor': '#ef5350',
                'mainSeriesProperties.candleStyle.borderUpColor': '#26a69a',
                'mainSeriesProperties.candleStyle.borderDownColor': '#ef5350'

            }
        });

        this.widget.onChartReady(() => {
            this.onChartReady();
        });
    }

    onChartReady() {
        this.widget.chart().onDataLoaded().subscribe(null, () => { });
        // this.createSellPriceLine();
        this.syncOpenPositionLines();
    }

    setOpenPositions(positions) {
        this.openPositions = Array.isArray(positions) ? positions : [];
        this.syncOpenPositionLines();
    }

    clearOpenPositionLines() {
        this.positionLines.forEach((line) => {
            try {
                if (line && typeof line.remove === 'function') {
                    line.remove();
                }
            } catch (_) {
            }
        });
        this.positionLines.clear();
    }

    getPositionLineKey(position) {
        if (!position) return null;
        if (position.order_id !== undefined && position.order_id !== null) {
            return String(position.order_id);
        }
        const symbol = position.order_company_name || '';
        const type = position.order_type || '';
        const price = position.order_price || '';
        const qty = position.order_quantity || '';
        const created = position.created_at || '';
        return `${symbol}|${type}|${price}|${qty}|${created}`;
    }

    formatPositionLabel(position, currentPrice) {
        const type = (position.order_type || '').toUpperCase();
        const qty = parseFloat(position.order_quantity) || 0;
        const qtyText = qty.toFixed(2);
        // Only BUY/SELL and quantity
        return `${type} ${qtyText}`;
    }

    getCurrentClosePrice(position) {
        if (!window.marketDataCache || !position) return null;

        const symbol = position.order_company_name;
        const data = window.marketDataCache.get(symbol);
        if (!data) return null;

        const bid = data.bid;
        const ask = data.ask;
        if (bid === undefined || bid === null || ask === undefined || ask === null) return null;

        const spreadAdjusted = window.calculateSpreadAdjustedPrices
            ? window.calculateSpreadAdjustedPrices(bid, ask, symbol)
            : { bid: parseFloat(bid), ask: parseFloat(ask) };

        const type = (position.order_type || '').toUpperCase();
        return type === 'BUY' ? spreadAdjusted.bid : spreadAdjusted.ask;
    }

    createOrUpdatePositionLine(position) {
        if (!this.widget) return;
        const chart = this.widget.chart && this.widget.chart();
        if (!chart || typeof chart.createOrderLine !== 'function') return;

        const key = this.getPositionLineKey(position);
        if (!key) return;

        // Debug log
        console.log('[PositionLine] Processing position:', position.order_id, position.order_type, 'Price:', position.order_price, 'Qty:', position.order_quantity, 'PnL:', position.pnl, 'ContractValue:', position.contract_value);

        let line = this.positionLines.get(key);
        const type = (position.order_type || '').toUpperCase();

        // Calculate P&L first to determine colors
        const currentPrice = this.getCurrentClosePrice(position);
        let plValue = 0;

        // Priority 1: Use pre-calculated pnl from Flutter if available
        if (position.pnl !== undefined && position.pnl !== null && position.pnl !== 0) {
            plValue = parseFloat(position.pnl);
        }
        // Priority 2: Calculate from current price
        else if (currentPrice && currentPrice > 0) {
            const calculated = window.calculatePL ? window.calculatePL(position, currentPrice) : '0.00';
            plValue = parseFloat(calculated);
        }

        console.log('[PositionLine] CurrentPrice:', currentPrice, 'Calculated PnL:', plValue);

        // Color based on P&L, not order type
        const lineColor = plValue > 0 ? '#36B34B' : plValue < 0 ? '#D80000' : '#888888';
        const plColor = plValue > 0 ? '#36B34B' : plValue < 0 ? '#D80000' : '#888888';

        if (!line) {
            line = chart.createOrderLine();
            this.positionLines.set(key, line);

            try {
                if (typeof line.setLineColor === 'function') line.setLineColor(lineColor);
                if (typeof line.setLineStyle === 'function') line.setLineStyle(2);
                if (typeof line.setLineLength === 'function') line.setLineLength(25);
            } catch (_) { }
        } else {
            // Update line color for existing lines
            try {
                if (typeof line.setLineColor === 'function') line.setLineColor(lineColor);
            } catch (_) { }
        }

        // Set price
        try {
            if (typeof line.setPrice === 'function') line.setPrice(parseFloat(position.order_price));
        } catch (_) { }

        const plText = `${plValue >= 0 ? '+' : ''}$${plValue.toFixed(2)}`;

        // Set quantity (P&L display)
        if (typeof line.setQuantity === 'function') {
            line.setQuantity(plText);
        }
        if (typeof line.setQuantityBackgroundColor === 'function') {
            line.setQuantityBackgroundColor(plColor);
        }
        if (typeof line.setQuantityTextColor === 'function') {
            line.setQuantityTextColor('#ffffff');
        }

        // Set label (BUY/SELL + quantity)
        const qty = parseFloat(position.order_quantity) || 0;
        const label = `${type} ${qty.toFixed(2)}`;

        if (typeof line.setText === 'function') {
            line.setText(label);
        }
        if (typeof line.setTextColor === 'function') {
            line.setTextColor(plColor);
        }
        if (typeof line.setBodyBackgroundColor === 'function') {
            line.setBodyBackgroundColor('rgba(0, 0, 0, 0)');
        }
        if (typeof line.setBodyBorderColor === 'function') {
            line.setBodyBorderColor(plColor);
        }
        if (typeof line.setBodyTextColor === 'function') {
            line.setBodyTextColor(plColor);
        }
    }


    syncOpenPositionLines() {
        if (!this.widget || !Array.isArray(this.openPositions)) return;

        const desiredKeys = new Set();
        this.openPositions.forEach((pos) => {
            const key = this.getPositionLineKey(pos);
            if (key) desiredKeys.add(key);
        });

        this.positionLines.forEach((line, key) => {
            if (!desiredKeys.has(key)) {
                try {
                    if (line && typeof line.remove === 'function') line.remove();
                } catch (_) {
                }
                this.positionLines.delete(key);
            }
        });

        this.openPositions.forEach((pos) => {
            this.createOrUpdatePositionLine(pos);
        });
    }

    createSellPriceLine() {
        setTimeout(() => {
            try {
                const cacheData = window.marketDataCache && window.marketDataCache.get(this.currentSymbol);
                if (!cacheData || !cacheData.bid) return;

                const symbolData = window.symbolGroupData && window.symbolGroupData.get(this.currentSymbol);
                const halfSpread = symbolData && symbolData.half_spread ? parseFloat(symbolData.half_spread) : 0;
                const sellPrice = parseFloat(cacheData.bid) - halfSpread;

                const chart = this.widget.chart();
                this.sellPriceLine = chart.createMultipointShape(
                    [{ time: chart.getVisibleRange().from, price: sellPrice }],
                    {
                        shape: 'horizontal_line',
                        lock: false,
                        overrides: {
                            'linecolor': '#ff4444',
                            'linewidth': 1,
                            'linestyle': 1,
                            'showLabel': true,
                            'textcolor': '#ff4444',
                            'fontsize': 12
                        }
                    }
                );
                this.startSellPriceUpdates();
            } catch (error) {
                console.error('[Chart] Error creating sell price line:', error);
            }
        }, 2000);
    }

    startSellPriceUpdates() {
        if (this.sellPriceInterval) clearInterval(this.sellPriceInterval);
        this.sellPriceInterval = setInterval(() => {
            this.updateSellPriceLine();
        }, 50);
    }

    updateSellPriceLine() {
        if (!window.marketDataCache || !this.sellPriceLine) return;
        const cacheData = window.marketDataCache.get(this.currentSymbol);
        if (!cacheData || !cacheData.bid) return;

        const symbolData = window.symbolGroupData && window.symbolGroupData.get(this.currentSymbol);
        const halfSpread = symbolData && symbolData.half_spread ? parseFloat(symbolData.half_spread) : 0;
        const sellPrice = parseFloat(cacheData.bid) - halfSpread;

        if (this.lastSellPrice !== sellPrice) {
            this.lastSellPrice = sellPrice;
            try {
                const chart = this.widget.chart();
                const visibleRange = chart.getVisibleRange();
                this.sellPriceLine.setPoints([
                    { time: visibleRange.from, price: sellPrice },
                    { time: visibleRange.to, price: sellPrice }
                ]);
            } catch (error) {
                // Ignore update errors during transition
            }
        }
    }

    changeSymbol(newSymbol) {
        if (this.currentSymbol === newSymbol) return;
        this.currentSymbol = newSymbol;
        this.clearOpenPositionLines();
        this.openPositions = [];
        if (this.widget) {
            this.widget.setSymbol(newSymbol, '15', () => { });
        }
    }

    pause() {
        if (this.sellPriceInterval) {
            clearInterval(this.sellPriceInterval);
            this.sellPriceInterval = null;
        }
    }

    resume() {
        if (!this.sellPriceInterval) {
            this.startSellPriceUpdates();
        }
    }

    destroy() {
        this.pause();
        this.clearOpenPositionLines();
        if (this.widget) {
            this.widget.remove();
            this.widget = null;
        }
    }
}

class ChartTabManager {
    constructor() {
        this.tabs = [];
        this.activeTabId = null;
        this.tabsListEl = document.getElementById('chartTabsList');
        this.addTabBtn = document.getElementById('addChartTabBtn');
        this.containerEl = document.getElementById('tv_chart_container');
        this.utcClockEl = document.getElementById('utcClock');

        if (this.addTabBtn) {
            this.addTabBtn.onclick = () => this.addTab();
        }

        this.startUTCClock();
        this.init();
    }

    startUTCClock() {
        this.updateUTCClock();
        setInterval(() => this.updateUTCClock(), 1000);
    }

    updateUTCClock() {
        if (!this.utcClockEl) return;
        const now = new Date();
        const h = String(now.getUTCHours()).padStart(2, '0');
        const m = String(now.getUTCMinutes()).padStart(2, '0');
        const s = String(now.getUTCSeconds()).padStart(2, '0');
        this.utcClockEl.textContent = `${h}:${m}:${s} (UTC)`;
    }

    init() {
        const lastSymbol = localStorage.getItem('lastChartSymbol') || 'AUDCAD';
        this.addTab(lastSymbol);
    }

    addTab(symbol = null) {
        const id = 'tab-' + Date.now();

        // Enforce max 6 tabs
        if (this.tabs.length >= 6) {
            this.removeTab(this.tabs[0].id);
        }

        const tabObj = {
            id: id,
            symbol: symbol,
            chart: null,
            container: null
        };

        const container = document.createElement('div');
        container.id = 'chart-container-' + id;
        container.className = 'chart-instance-container';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.display = 'none';
        this.containerEl.appendChild(container);

        tabObj.container = container;
        this.tabs.push(tabObj);

        this.selectTab(id);

        if (symbol) {
            tabObj.chart = new TradingViewChart(container.id, symbol);
        } else {
            this.showEmptyState(tabObj);
        }

        this.renderTabs();
        const active = this.getActiveTradingViewChart();
        window.tvWidget = active ? active.widget : null;
        if (window.syncChartOpenPositionsOverlay) {
            window.syncChartOpenPositionsOverlay();
        }
    }

    getActiveTradingViewChart() {
        const activeTab = this.tabs.find(t => t.id === this.activeTabId);
        return activeTab && activeTab.chart ? activeTab.chart : null;
    }

    showEmptyState(tabObj) {
        tabObj.container.innerHTML = `
            <div class="empty-chart-container">
                <i class="fas fa-chart-line"></i>
                <p>Select any symbol from the sidebar to view the chart</p>
            </div>
        `;
    }

    renderTabs() {
        if (!this.tabsListEl) return;
        this.tabsListEl.innerHTML = '';
        this.tabs.forEach(tab => {
            const tabEl = document.createElement('div');
            tabEl.className = 'chart-tab' + (tab.id === this.activeTabId ? ' active' : '');

            const name = tab.symbol ? tab.symbol : 'New Tab';

            tabEl.innerHTML = `
                <span class="tab-name">${name}</span>
                ${this.tabs.length > 1 ? '<i class="fas fa-times close-tab"></i>' : ''}
            `;

            tabEl.onclick = (e) => {
                if (e.target.classList.contains('close-tab')) {
                    e.stopPropagation();
                    this.removeTab(tab.id);
                } else {
                    this.selectTab(tab.id);
                }
            };
            this.tabsListEl.appendChild(tabEl);
        });
    }

    selectTab(id) {
        if (this.activeTabId === id) return;

        // Pause old chart
        const oldTab = this.tabs.find(t => t.id === this.activeTabId);
        if (oldTab && oldTab.chart) oldTab.chart.pause();

        this.activeTabId = id;
        this.tabs.forEach(tab => {
            tab.container.style.display = (tab.id === id ? 'block' : 'none');
        });

        // Resume new chart
        const newTab = this.tabs.find(t => t.id === id);
        if (newTab && newTab.chart) newTab.chart.resume();

        window.tvWidget = newTab && newTab.chart ? newTab.chart.widget : null;

        // Update global symbol and trigger popup refresh
        if (newTab && newTab.symbol) {
            localStorage.setItem('lastChartSymbol', newTab.symbol);
            if (window.updateInstantTradePopupPrices) {
                window.updateInstantTradePopupPrices(newTab.symbol);
            }
        }

        this.renderTabs();
        if (window.syncChartOpenPositionsOverlay) {
            window.syncChartOpenPositionsOverlay();
        }
    }

    removeTab(id) {
        const index = this.tabs.findIndex(t => t.id === id);
        if (index === -1) return;

        const tab = this.tabs[index];
        if (tab.chart) tab.chart.destroy();
        tab.container.remove();
        this.tabs.splice(index, 1);

        if (this.activeTabId === id) {
            const nextTab = this.tabs[index] || this.tabs[index - 1];
            if (nextTab) this.selectTab(nextTab.id);
        } else {
            this.renderTabs();
        }
    }

    changeSymbol(symbol) {
        // 1. Check if already open in ANY tab
        const existingTab = this.tabs.find(t => t.symbol === symbol);
        if (existingTab) {
            this.selectTab(existingTab.id);
            return;
        }

        let activeTab = this.tabs.find(t => t.id === this.activeTabId);

        // 2. If active tab is empty (placeholder), fill it
        if (activeTab && !activeTab.chart) {
            activeTab.symbol = symbol;
            localStorage.setItem('lastChartSymbol', symbol);
            activeTab.container.innerHTML = '';
            activeTab.chart = new TradingViewChart(activeTab.container.id, symbol);
            window.tvWidget = activeTab.chart ? activeTab.chart.widget : null;
            this.renderTabs();
            // Sync popup
            if (window.updateInstantTradePopupPrices) window.updateInstantTradePopupPrices();
            if (window.syncChartOpenPositionsOverlay) {
                window.syncChartOpenPositionsOverlay();
            }
            return;
        }

        // 3. Otherwise, open in a new tab (smart creation with 6-tab limit check happens in addTab)
        this.addTab(symbol);
    }

    // Proxy getters/setters for compatibility with existing scripts
    get currentSymbol() {
        const activeTab = this.tabs.find(t => t.id === this.activeTabId);
        return activeTab ? activeTab.symbol : null;
    }

    set currentSymbol(symbol) {
        this.changeSymbol(symbol);
    }

    get widget() {
        const activeTab = this.tabs.find(t => t.id === this.activeTabId);
        return activeTab && activeTab.chart ? activeTab.chart.widget : null;
    }

    // Apply new theme by recreating all tab charts
    applyTheme() {
        console.log('[ChartTabManager] Applying theme change to all tabs...');
        this.tabs.forEach(tab => {
            if (tab.chart && tab.symbol) {
                // Destroy existing chart
                tab.chart.destroy();
                tab.chart = null;
                // Clear the container
                tab.container.innerHTML = '';
                // Recreate chart with same symbol (it will pick up new theme from getInitialTheme)
                tab.chart = new TradingViewChart(tab.container.id, tab.symbol);
            }
        });
        // Update global widget reference
        const active = this.getActiveTradingViewChart();
        window.tvWidget = active ? active.widget : null;
        console.log('[ChartTabManager] Theme applied to all tabs');
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.chart = new ChartTabManager();
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
    if (window.chart && window.chart.tabs) {
        window.chart.tabs.forEach(tab => {
            if (tab.chart) tab.chart.destroy();
        });
    }
});
