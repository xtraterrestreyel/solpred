/* SolPred - app logic
 * Live prices: Coinbase Exchange public API, CoinGecko fallback, simulated feed as last resort.
 * Predictions: paper SOL, parimutuel pools, stored in the browser (localStorage).
 */
(function () {
    'use strict';

    // ---------------------------------------------------------------- config
    var ASSETS = {
        BTC:  { name: 'Bitcoin',  product: 'BTC-USD',  cg: 'bitcoin',  icon: 'fa-brands fa-bitcoin',  seed: 95000, poolScale: 1.0 },
        ETH:  { name: 'Ethereum', product: 'ETH-USD',  cg: 'ethereum', icon: 'fa-brands fa-ethereum', seed: 3400,  poolScale: 0.75 },
        SOL:  { name: 'Solana',   product: 'SOL-USD',  cg: 'solana',   icon: 'fa-solid fa-sun',       seed: 180,   poolScale: 0.9 },
        DOGE: { name: 'Dogecoin', product: 'DOGE-USD', cg: 'dogecoin', icon: 'fa-solid fa-dog',       seed: 0.2,   poolScale: 0.45 }
    };
    var SYMBOLS = Object.keys(ASSETS);

    var MIN = 60 * 1000;
    var HOUR = 60 * MIN;
    var TIMEFRAMES = {
        '15m': { label: '15 min',  long: '15 minute', ms: 15 * MIN, histGran: 900,   chartGran: 60,  chartWindow: 60 * MIN,  poolMult: 1 },
        '1h':  { label: '1 hour',  long: '1 hour',    ms: HOUR,     histGran: 3600,  chartGran: 60,  chartWindow: 2 * HOUR,  poolMult: 1.8 },
        '2h':  { label: '2 hours', long: '2 hour',    ms: 2 * HOUR, histGran: 3600,  chartGran: 60,  chartWindow: 4 * HOUR,  poolMult: 2.6 },
        '5h':  { label: '5 hours', long: '5 hour',    ms: 5 * HOUR, histGran: 3600,  chartGran: 300, chartWindow: 10 * HOUR, poolMult: 4 },
        '24h': { label: '24 hours', long: '24 hour',  ms: 24 * HOUR, histGran: 86400, chartGran: 300, chartWindow: 24 * HOUR, poolMult: 7 }
    };
    var TF_KEYS = Object.keys(TIMEFRAMES);

    var FEE = 0.03;
    var LOCK_MS = 30 * 1000;
    var START_BALANCE = 10;
    var STORE_KEY = 'solpred:v1';
    var CB = 'https://api.exchange.coinbase.com';
    var CG = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,dogecoin&vs_currencies=usd&include_24hr_change=true';
    var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    // ---------------------------------------------------------------- helpers
    var $ = function (id) { return document.getElementById(id); };

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function hashStr(str) {
        var h = 2166136261;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function rng(seed) {
        var a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function randomAddress(r, len) {
        r = r || Math.random;
        var s = '';
        for (var i = 0; i < (len || 44); i++) s += B58[Math.floor(r() * B58.length)];
        return s;
    }

    function shortAddr(a) { return a ? a.slice(0, 4) + '...' + a.slice(-4) : ''; }

    function decimalsFor(price) {
        if (price >= 1000) return 2;
        if (price >= 1) return 3;
        if (price >= 0.01) return 5;
        return 7;
    }

    var fmtCache = {};
    function fmtUSD(v) {
        if (v == null || !isFinite(v)) return '--';
        var dp = decimalsFor(Math.abs(v));
        if (!fmtCache[dp]) {
            fmtCache[dp] = new Intl.NumberFormat('en-US', {
                style: 'currency', currency: 'USD', minimumFractionDigits: dp, maximumFractionDigits: dp
            });
        }
        return fmtCache[dp].format(v);
    }

    function fmtSOL(v, dp) {
        if (v == null || !isFinite(v)) return '--';
        return v.toLocaleString('en-US', { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp });
    }

    function fmtPct(v, withSign) {
        if (v == null || !isFinite(v)) return '--';
        var s = Math.abs(v).toFixed(2) + '%';
        if (withSign === false) return s;
        return (v > 0 ? '+' : v < 0 ? '-' : '') + s;
    }

    function fmtDuration(ms) {
        ms = Math.max(0, ms);
        var total = Math.floor(ms / 1000);
        var h = Math.floor(total / 3600);
        var m = Math.floor((total % 3600) / 60);
        var s = total % 60;
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
    }

    function fmtTime(ms, withDate) {
        var d = new Date(ms);
        var opts = { hour: '2-digit', minute: '2-digit' };
        if (withDate) { opts.month = 'short'; opts.day = 'numeric'; }
        return d.toLocaleString(undefined, opts);
    }

    function fetchJSON(url, timeoutMs) {
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 7000);
        return fetch(url, { signal: ctrl ? ctrl.signal : undefined, headers: { Accept: 'application/json' } })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .finally(function () { clearTimeout(timer); });
    }

    // ---------------------------------------------------------------- storage
    function loadStore() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
    }

    function saveStore() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify({
                wallet: state.wallet,
                balances: state.balances,
                positions: state.positions,
                strikes: state.strikes,
                asset: state.asset,
                tf: state.tf
            }));
        } catch (e) { /* storage full or blocked; app keeps working in memory */ }
    }

    // ---------------------------------------------------------------- state
    var stored = loadStore();
    var state = {
        asset: ASSETS[stored.asset] ? stored.asset : 'BTC',
        tf: TIMEFRAMES[stored.tf] ? stored.tf : '15m',
        direction: null,
        prices: {},
        feed: 'connecting',
        feedSource: '',
        chart: { key: null, points: [], loading: false },
        history: { key: null, rows: null, loading: false, fetchedAt: 0 },
        strikes: stored.strikes || {},
        strikePending: {},
        positions: Array.isArray(stored.positions) ? stored.positions : [],
        balances: stored.balances || {},
        wallet: stored.wallet || null,
        lastRoundStart: null,
        settling: {}
    };

    SYMBOLS.forEach(function (s) {
        state.prices[s] = { price: null, prev: null, change24: null, open24: null };
    });

    // prune strike cache older than 3 days
    (function pruneStrikes() {
        var cutoff = Date.now() - 3 * 24 * HOUR;
        Object.keys(state.strikes).forEach(function (k) {
            var start = Number(k.split('|')[2]);
            if (!(start > cutoff)) delete state.strikes[k];
        });
    })();

    // ---------------------------------------------------------------- rounds & pools
    function roundOf(tf, now) {
        var ms = TIMEFRAMES[tf].ms;
        var start = Math.floor((now || Date.now()) / ms) * ms;
        return { start: start, end: start + ms };
    }

    function roundKey(asset, tf, start) { return asset + '|' + tf + '|' + start; }

    function userStakes(asset, tf, start) {
        var up = 0, down = 0;
        state.positions.forEach(function (p) {
            if (p.asset === asset && p.tf === tf && p.start === start) {
                if (p.direction === 'UP') up += p.stake; else down += p.stake;
            }
        });
        return { up: up, down: down };
    }

    // Simulated crowd liquidity: deterministic per round, grows as the round goes on.
    function poolFor(asset, tf, start, atTime) {
        var cfg = TIMEFRAMES[tf];
        var r = rng(hashStr(roundKey(asset, tf, start)));
        var base = (40 + r() * 160) * ASSETS[asset].poolScale * cfg.poolMult;
        var share = 0.32 + r() * 0.36;
        var phase = r() * Math.PI * 2;
        var frac = clamp(((atTime || Date.now()) - start) / cfg.ms, 0, 1);
        var growth = 0.12 + 0.88 * Math.pow(frac, 0.8);
        share = clamp(share + 0.07 * Math.sin(frac * 7 + phase), 0.15, 0.85);
        var mine = userStakes(asset, tf, start);
        var up = base * share * growth + mine.up;
        var down = base * (1 - share) * growth + mine.down;
        return { up: up, down: down, total: up + down };
    }

    function multiplier(pool, dir, extraStake) {
        var s = extraStake || 0;
        var side = (dir === 'UP' ? pool.up : pool.down) + s;
        if (side <= 0) return 0;
        return ((pool.total + s) * (1 - FEE)) / side;
    }

    // ---------------------------------------------------------------- price feed
    var simTimer = null;

    function setPrice(sym, price) {
        if (!isFinite(price) || price <= 0) return;
        var p = state.prices[sym];
        p.prev = p.price;
        p.price = price;
        if (p.open24) p.change24 = ((price - p.open24) / p.open24) * 100;
        if (sym === state.asset) appendChartPoint(Date.now(), price);
    }

    function setFeed(mode, source) {
        state.feed = mode;
        state.feedSource = source || '';
        var el = $('feed-status');
        el.classList.toggle('live', mode === 'live');
        el.classList.toggle('sim', mode === 'sim');
        $('feed-label').textContent = mode === 'live' ? 'Live' : mode === 'sim' ? 'Simulated feed' : 'Connecting';
        el.title = mode === 'live' ? 'Live prices from ' + source
            : mode === 'sim' ? 'Market data is unreachable, so prices are simulated. Retrying every 30 seconds.'
            : 'Connecting to price feed';
    }

    function pollCoinbase() {
        return Promise.all(SYMBOLS.map(function (s) {
            return fetchJSON(CB + '/products/' + ASSETS[s].product + '/ticker');
        })).then(function (rows) {
            rows.forEach(function (r, i) { setPrice(SYMBOLS[i], parseFloat(r.price)); });
            setFeed('live', 'Coinbase');
        });
    }

    function pollCoinGecko() {
        return fetchJSON(CG).then(function (d) {
            var any = false;
            SYMBOLS.forEach(function (s) {
                var row = d[ASSETS[s].cg];
                if (row && row.usd) {
                    any = true;
                    setPrice(s, row.usd);
                    if (row.usd_24h_change != null) {
                        state.prices[s].change24 = row.usd_24h_change;
                        state.prices[s].open24 = row.usd / (1 + row.usd_24h_change / 100);
                    }
                }
            });
            if (!any) throw new Error('empty');
            setFeed('live', 'CoinGecko');
        });
    }

    function simulateTick() {
        SYMBOLS.forEach(function (s) {
            var p = state.prices[s];
            var last = p.price || ASSETS[s].seed;
            if (!p.open24) p.open24 = last * (1 + (Math.random() - 0.5) * 0.04);
            var next = last * (1 + (Math.random() - 0.5) * 0.0012);
            setPrice(s, next);
        });
        renderTicker();
        renderMarket();
    }

    function startSim() {
        if (simTimer) return;
        setFeed('sim');
        simulateTick();
        simTimer = setInterval(simulateTick, 2000);
    }

    function stopSim() {
        if (simTimer) { clearInterval(simTimer); simTimer = null; }
    }

    function pollPrices() {
        pollCoinbase()
            .then(function () { stopSim(); return 4000; })
            .catch(function () {
                return pollCoinGecko()
                    .then(function () { stopSim(); return 30000; })
                    .catch(function () { startSim(); return 30000; });
            })
            .then(function (delay) {
                renderTicker();
                renderMarket();
                setTimeout(pollPrices, delay);
            });
    }

    function pollStats() {
        SYMBOLS.forEach(function (s) {
            fetchJSON(CB + '/products/' + ASSETS[s].product + '/stats').then(function (st) {
                var open = parseFloat(st.open);
                var p = state.prices[s];
                if (open > 0) {
                    p.open24 = open;
                    if (p.price) p.change24 = ((p.price - open) / open) * 100;
                }
            }).catch(function () { /* change comes from CoinGecko or sim instead */ });
        });
        setTimeout(function () { renderTicker(); }, 1500);
    }

    function fetchCandles(product, gran, startMs, endMs) {
        var url = CB + '/products/' + product + '/candles?granularity=' + gran;
        if (startMs != null) {
            url += '&start=' + encodeURIComponent(new Date(startMs).toISOString()) +
                   '&end=' + encodeURIComponent(new Date(endMs).toISOString());
        }
        return fetchJSON(url, 9000).then(function (rows) {
            if (!Array.isArray(rows)) throw new Error('Unexpected candle response');
            return rows.map(function (r) {
                return { t: r[0] * 1000, low: r[1], high: r[2], open: r[3], close: r[4] };
            }).sort(function (a, b) { return a.t - b.t; });
        });
    }

    // Price at an exact minute boundary: the open of that 1 minute candle.
    function priceAt(asset, ms) {
        return fetchCandles(ASSETS[asset].product, 60, ms, ms + 2 * MIN).then(function (c) {
            if (!c.length) throw new Error('No candle yet');
            var exact = c.filter(function (x) { return x.t === ms; })[0];
            return (exact || c[0]).open;
        });
    }

    // ---------------------------------------------------------------- strikes
    function currentStrike(asset, tf) {
        var r = roundOf(tf);
        var key = roundKey(asset, tf, r.start);
        var s = state.strikes[key];
        if (s) return s;
        if (!state.strikePending[key]) {
            state.strikePending[key] = true;
            var fallback = function () {
                var live = state.prices[asset].price;
                if (live) {
                    state.strikes[key] = { price: live, approx: true };
                    saveStore();
                    renderMarket();
                }
                state.strikePending[key] = false;
            };
            if (state.feed === 'sim') {
                fallback();
            } else {
                priceAt(asset, r.start).then(function (price) {
                    state.strikes[key] = { price: price, approx: false };
                    saveStore();
                    state.strikePending[key] = false;
                    renderMarket();
                    drawChart();
                }).catch(fallback);
            }
        }
        return null;
    }

    // ---------------------------------------------------------------- chart
    function chartKey() { return state.asset + '|' + state.tf; }

    function synthSeries(price, count, stepMs) {
        var pts = [];
        var p = price;
        var now = Date.now();
        for (var i = 0; i < count; i++) {
            pts.push({ t: now - i * stepMs, p: p });
            p = p / (1 + (Math.random() - 0.5) * 0.003);
        }
        return pts.reverse();
    }

    function loadChart(silent) {
        var key = chartKey();
        var cfg = TIMEFRAMES[state.tf];
        var asset = state.asset;
        if (silent === true && state.chart.key === key && state.chart.points.length) {
            fetchCandles(ASSETS[asset].product, cfg.chartGran).then(function (c) {
                if (state.chart.key !== key) return;
                var pts = c.map(function (x) { return { t: x.t + cfg.chartGran * 1000, p: x.close }; });
                var lastT = pts.length ? pts[pts.length - 1].t : 0;
                state.chart.points.forEach(function (x) { if (x.t > lastT) pts.push(x); });
                state.chart.points = pts;
                drawChart();
            }).catch(function () { /* keep the current series */ });
            return;
        }
        state.chart.key = key;
        state.chart.loading = true;
        drawChart();

        var done = function (points) {
            if (state.chart.key !== key) return;
            state.chart.points = points;
            state.chart.loading = false;
            drawChart();
        };

        fetchCandles(ASSETS[asset].product, cfg.chartGran).then(function (c) {
            var pts = c.map(function (x) { return { t: x.t + cfg.chartGran * 1000, p: x.close }; });
            var live = state.prices[asset].price;
            if (live) pts.push({ t: Date.now(), p: live });
            done(pts);
        }).catch(function () {
            var live = state.prices[asset].price || ASSETS[asset].seed;
            done(synthSeries(live, 240, cfg.chartWindow / 240));
        });
    }

    function appendChartPoint(t, p) {
        if (state.chart.key !== chartKey() || state.chart.loading) return;
        var pts = state.chart.points;
        var last = pts[pts.length - 1];
        if (last && t - last.t < 1000) { last.p = p; return; }
        pts.push({ t: t, p: p });
        if (pts.length > 2000) pts.splice(0, pts.length - 2000);
    }

    var canvas = null, ctx = null;

    function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    function drawChart() {
        if (!canvas) return;
        var empty = $('chart-empty');
        var w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        var dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        var cfg = TIMEFRAMES[state.tf];
        var now = Date.now();
        var round = roundOf(state.tf, now);
        var tMin = now - cfg.chartWindow;
        var tMax = now + Math.min(round.end - now, cfg.chartWindow * 0.25);
        var pts = state.chart.points.filter(function (x) { return x.t >= tMin; });

        if (state.chart.loading || pts.length < 2) {
            empty.textContent = state.chart.loading ? 'Loading chart' : 'Waiting for price data';
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');

        var strikeObj = state.strikes[roundKey(state.asset, state.tf, round.start)];
        var strike = strikeObj ? strikeObj.price : null;

        var lo = Infinity, hi = -Infinity;
        pts.forEach(function (x) { if (x.p < lo) lo = x.p; if (x.p > hi) hi = x.p; });
        if (strike) { lo = Math.min(lo, strike); hi = Math.max(hi, strike); }
        var pad = (hi - lo) * 0.12 || hi * 0.001;
        lo -= pad; hi += pad;

        var padL = 8, padR = 78, padT = 12, padB = 24;
        var plotW = w - padL - padR, plotH = h - padT - padB;
        var X = function (t) { return padL + ((t - tMin) / (tMax - tMin)) * plotW; };
        var Y = function (p) { return padT + (1 - (p - lo) / (hi - lo)) * plotH; };

        var cLine = cssVar('--line-soft') || '#1B2644';
        var cMuted = cssVar('--muted') || '#7D89AB';
        var cText2 = cssVar('--text-2') || '#B4BDD6';
        var cViolet = cssVar('--violet') || '#8C6CFF';
        var cMint = cssVar('--mint') || '#14F195';
        var cUp = cssVar('--up') || '#22D3A0';
        var cDown = cssVar('--down') || '#FF5A76';
        var fontNum = '11px ' + (cssVar('--font-num') || 'monospace');

        // grid + price axis
        ctx.font = fontNum;
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 1;
        for (var i = 0; i <= 4; i++) {
            var gy = padT + (plotH / 4) * i;
            ctx.strokeStyle = cLine;
            ctx.beginPath(); ctx.moveTo(padL, gy + 0.5); ctx.lineTo(padL + plotW, gy + 0.5); ctx.stroke();
            ctx.fillStyle = cMuted;
            ctx.textAlign = 'left';
            ctx.fillText(fmtUSD(hi - ((hi - lo) / 4) * i), padL + plotW + 8, gy);
        }

        // time axis
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'center';
        for (var j = 0; j <= 3; j++) {
            var tt = tMin + ((now - tMin) / 3) * j;
            var tx = X(tt);
            ctx.fillStyle = cMuted;
            ctx.fillText(fmtTime(tt, cfg.ms >= 24 * HOUR), clamp(tx, padL + 22, padL + plotW - 22), h - 6);
        }

        // future region until round close
        var xNow = X(now);
        if (tMax > now) {
            ctx.fillStyle = 'rgba(140, 108, 255, 0.05)';
            ctx.fillRect(xNow, padT, padL + plotW - xNow, plotH);
        }

        // round open marker
        if (round.start > tMin) {
            var xs = X(round.start);
            ctx.save();
            ctx.setLineDash([2, 4]);
            ctx.strokeStyle = cMuted;
            ctx.beginPath(); ctx.moveTo(xs + 0.5, padT); ctx.lineTo(xs + 0.5, padT + plotH); ctx.stroke();
            ctx.restore();
            ctx.fillStyle = cMuted;
            ctx.textAlign = 'left';
            ctx.fillText('Round open', Math.min(xs + 6, padL + plotW - 70), padT + 12);
        }

        // area + line
        var grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, 'rgba(140, 108, 255, 0.28)');
        grad.addColorStop(1, 'rgba(140, 108, 255, 0)');
        ctx.beginPath();
        pts.forEach(function (x, k) { if (k === 0) ctx.moveTo(X(x.t), Y(x.p)); else ctx.lineTo(X(x.t), Y(x.p)); });
        ctx.lineTo(X(pts[pts.length - 1].t), padT + plotH);
        ctx.lineTo(X(pts[0].t), padT + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        var lineGrad = ctx.createLinearGradient(padL, 0, xNow, 0);
        lineGrad.addColorStop(0, cViolet);
        lineGrad.addColorStop(1, cMint);
        ctx.beginPath();
        pts.forEach(function (x, k) { if (k === 0) ctx.moveTo(X(x.t), Y(x.p)); else ctx.lineTo(X(x.t), Y(x.p)); });
        ctx.strokeStyle = lineGrad;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // strike line
        if (strike) {
            var sy = Y(strike);
            ctx.save();
            ctx.setLineDash([5, 5]);
            ctx.strokeStyle = cText2;
            ctx.globalAlpha = 0.6;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(padL, sy + 0.5); ctx.lineTo(padL + plotW, sy + 0.5); ctx.stroke();
            ctx.restore();
            var label = 'Strike';
            ctx.font = '600 ' + fontNum;
            var lw = ctx.measureText(label).width + 12;
            ctx.fillStyle = 'rgba(29, 42, 76, 0.95)';
            roundRect(ctx, padL + 4, sy - 10, lw, 20, 6);
            ctx.fill();
            ctx.fillStyle = cText2;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, padL + 10, sy);
            ctx.font = fontNum;
        }

        // last price dot + tag
        var last = pts[pts.length - 1];
        var lx = X(last.t), ly = Y(last.p);
        var above = strike ? last.p >= strike : true;
        var dotColor = strike ? (above ? cUp : cDown) : cMint;
        ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2);
        ctx.fillStyle = dotColor; ctx.globalAlpha = 0.2; ctx.fill(); ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = dotColor; ctx.fill();

        var tag = fmtUSD(last.p);
        var tw = ctx.measureText(tag).width + 12;
        ctx.fillStyle = dotColor;
        roundRect(ctx, padL + plotW + 2, ly - 10, Math.min(tw, padR - 4), 20, 6);
        ctx.fill();
        ctx.fillStyle = '#06120D';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag, padL + plotW + 8, ly);
    }

    function roundRect(c, x, y, w, h, r) {
        c.beginPath();
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
    }

    // ---------------------------------------------------------------- history
    function aggregate(candles, tfMs, now) {
        var buckets = {};
        candles.forEach(function (c) {
            var b = Math.floor(c.t / tfMs) * tfMs;
            if (!buckets[b]) buckets[b] = { start: b, open: c.open, close: c.close, firstT: c.t, lastT: c.t };
            var x = buckets[b];
            if (c.t < x.firstT) { x.firstT = c.t; x.open = c.open; }
            if (c.t > x.lastT) { x.lastT = c.t; x.close = c.close; }
        });
        return Object.keys(buckets).map(function (k) { return buckets[k]; })
            .filter(function (x) { return x.start + tfMs <= now && x.firstT === x.start; })
            .sort(function (a, b) { return b.start - a.start; });
    }

    function loadHistory(force) {
        var key = chartKey();
        if (!force && state.history.key === key && state.history.rows && Date.now() - state.history.fetchedAt < 60000) {
            renderHistory();
            return;
        }
        var cfg = TIMEFRAMES[state.tf];
        var asset = state.asset;
        state.history = { key: key, rows: null, loading: true, fetchedAt: Date.now() };
        renderHistory();

        var finish = function (rows, simulated) {
            if (state.history.key !== key) return;
            state.history.rows = rows.slice(0, 8);
            state.history.loading = false;
            state.history.simulated = simulated;
            renderHistory();
        };

        fetchCandles(ASSETS[asset].product, cfg.histGran).then(function (c) {
            finish(aggregate(c, cfg.ms, Date.now()), false);
        }).catch(function () {
            var live = state.prices[asset].price || ASSETS[asset].seed;
            var rows = [];
            var r = roundOf(state.tf);
            var p = live;
            for (var i = 1; i <= 8; i++) {
                var close = p;
                var open = close / (1 + (Math.random() - 0.5) * 0.01 * Math.sqrt(cfg.ms / (15 * MIN)));
                rows.push({ start: r.start - i * cfg.ms, open: open, close: close });
                p = open;
            }
            finish(rows, true);
        });
    }

    function renderHistory() {
        var body = $('history-body');
        var cfg = TIMEFRAMES[state.tf];
        $('history-sub').textContent = state.asset + ', ' + cfg.label + ' rounds' + (state.history.simulated ? ' (simulated)' : '');
        var h = state.history;
        if (!h.rows) {
            body.innerHTML = '<tr><td colspan="5" class="table-empty">' + (h.loading ? 'Loading past rounds' : 'No past rounds yet') + '</td></tr>';
            return;
        }
        if (!h.rows.length) {
            body.innerHTML = '<tr><td colspan="5" class="table-empty">No completed rounds in range yet</td></tr>';
            return;
        }
        body.innerHTML = h.rows.map(function (row) {
            var move = ((row.close - row.open) / row.open) * 100;
            var out = row.close > row.open ? 'up' : row.close < row.open ? 'down' : 'flat';
            var label = out === 'up' ? '<i class="fa-solid fa-arrow-up" aria-hidden="true"></i> Up'
                : out === 'down' ? '<i class="fa-solid fa-arrow-down" aria-hidden="true"></i> Down' : 'Flat';
            return '<tr>' +
                '<td>' + esc(fmtTime(row.start + cfg.ms, true)) + '</td>' +
                '<td>' + esc(fmtUSD(row.open)) + '</td>' +
                '<td>' + esc(fmtUSD(row.close)) + '</td>' +
                '<td class="move ' + out + '">' + esc(fmtPct(move)) + '</td>' +
                '<td><span class="outcome ' + out + '">' + label + '</span></td>' +
                '</tr>';
        }).join('');
    }

    // ---------------------------------------------------------------- wallet
    function getPhantom() {
        if (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom) return window.phantom.solana;
        if (window.solana && window.solana.isPhantom) return window.solana;
        return null;
    }

    function balance() {
        if (!state.wallet) return 0;
        var b = state.balances[state.wallet.address];
        return typeof b === 'number' ? b : START_BALANCE;
    }

    function setBalance(v) {
        if (!state.wallet) return;
        state.balances[state.wallet.address] = Math.max(0, Math.round(v * 1e6) / 1e6);
    }

    function setWallet(w) {
        state.wallet = w;
        if (w && typeof state.balances[w.address] !== 'number') state.balances[w.address] = START_BALANCE;
        saveStore();
        renderWallet();
        renderSlip();
        renderPositions();
        renderLeaderboard();
    }

    function connectWallet() {
        var provider = getPhantom();
        if (provider) {
            return provider.connect().then(function (resp) {
                setWallet({ address: resp.publicKey.toString(), type: 'phantom' });
                toast('Phantom connected. You start with ' + START_BALANCE + ' paper SOL.', 'success');
            }).catch(function () {
                toast('The connection request was declined in Phantom.', 'error');
            });
        }
        setWallet({ address: randomAddress(), type: 'demo' });
        toast('Phantom was not detected, so a demo wallet was created with ' + START_BALANCE + ' paper SOL.', 'info');
        return Promise.resolve();
    }

    function disconnectWallet() {
        var provider = getPhantom();
        if (state.wallet && state.wallet.type === 'phantom' && provider) {
            try { provider.disconnect(); } catch (e) { /* ignore */ }
        }
        setWallet(null);
        toast('Wallet disconnected.', 'info');
    }

    function restoreWallet() {
        if (!state.wallet) return;
        if (state.wallet.type === 'demo') { renderWallet(); return; }
        var provider = getPhantom();
        if (!provider) { state.wallet = null; renderWallet(); return; }
        provider.connect({ onlyIfTrusted: true }).then(function (resp) {
            setWallet({ address: resp.publicKey.toString(), type: 'phantom' });
        }).catch(function () {
            state.wallet = null;
            saveStore();
            renderWallet();
        });
    }

    function watchPhantom() {
        var provider = getPhantom();
        if (!provider || !provider.on) return;
        provider.on('accountChanged', function (pk) {
            if (pk) setWallet({ address: pk.toString(), type: 'phantom' });
            else if (state.wallet && state.wallet.type === 'phantom') setWallet(null);
        });
        provider.on('disconnect', function () {
            if (state.wallet && state.wallet.type === 'phantom') setWallet(null);
        });
    }

    function renderWallet() {
        var btn = $('wallet-btn');
        var text = $('wallet-btn-text');
        if (state.wallet) {
            btn.classList.add('connected');
            text.textContent = shortAddr(state.wallet.address) + (state.wallet.type === 'demo' ? ' (demo)' : '');
            btn.title = 'Click to disconnect';
        } else {
            btn.classList.remove('connected');
            text.textContent = 'Connect wallet';
            btn.title = '';
        }
        var bal = state.wallet ? fmtSOL(balance()) + ' SOL' : 'Not connected';
        $('balance-top').textContent = bal;
        $('balance-val').textContent = state.wallet ? fmtSOL(balance()) : '--';
    }

    // ---------------------------------------------------------------- slip & betting
    function stakeValue() {
        var v = parseFloat($('stake-input').value);
        return isFinite(v) ? v : 0;
    }

    function selectDirection(dir) {
        state.direction = state.direction === dir ? null : dir;
        renderMarket();
        renderSlip();
        if (state.direction && window.matchMedia('(max-width: 1024px)').matches) {
            $('slip-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function slipError(msg) {
        var el = $('slip-error');
        el.textContent = msg || '';
        el.classList.toggle('hidden', !msg);
    }

    function renderSlip() {
        var hasDir = !!state.direction;
        $('slip-empty').classList.toggle('hidden', hasDir);
        $('slip-active').classList.toggle('hidden', !hasDir);
        if (!hasDir) return;

        var round = roundOf(state.tf);
        var pool = poolFor(state.asset, state.tf, round.start);
        var stake = stakeValue();
        var mult = multiplier(pool, state.direction, stake > 0 ? stake : 0);

        $('slip-market').textContent = state.asset + ', ' + TIMEFRAMES[state.tf].label;
        var dirEl = $('slip-direction');
        dirEl.textContent = state.direction === 'UP' ? 'Up' : 'Down';
        dirEl.className = state.direction === 'UP' ? 't-up' : 't-down';
        $('slip-mult').textContent = mult ? mult.toFixed(2) + 'x' : '--';
        $('slip-payout').textContent = stake > 0 ? fmtSOL(stake * mult, 3) + ' SOL' : '--';

        var btn = $('confirm-btn');
        var locked = round.end - Date.now() <= LOCK_MS;
        if (!state.wallet) {
            btn.textContent = 'Connect wallet to predict';
            btn.disabled = false;
        } else if (locked) {
            btn.textContent = 'Round closing, next one opens soon';
            btn.disabled = true;
        } else {
            btn.textContent = 'Place prediction';
            btn.disabled = false;
        }
    }

    function placePrediction() {
        slipError('');
        if (!state.wallet) { connectWallet(); return; }
        if (!state.direction) return;

        var now = Date.now();
        var round = roundOf(state.tf, now);
        var stake = Math.round(stakeValue() * 1e4) / 1e4;
        var strike = state.strikes[roundKey(state.asset, state.tf, round.start)];

        if (!(stake >= 0.01)) return slipError('Enter a stake of at least 0.01 SOL.');
        if (stake > balance() + 1e-9) return slipError('Stake is higher than your balance of ' + fmtSOL(balance()) + ' SOL.');
        if (round.end - now <= LOCK_MS) return slipError('This round is closed to new predictions. The next round opens in ' + fmtDuration(round.end - now) + '.');
        if (!strike) return slipError('The strike price is still loading. Try again in a moment.');

        var pos = {
            id: 'p' + now.toString(36) + Math.random().toString(36).slice(2, 6),
            wallet: state.wallet.address,
            asset: state.asset,
            tf: state.tf,
            direction: state.direction,
            stake: stake,
            strike: strike.price,
            start: round.start,
            end: round.end,
            placedAt: now,
            status: 'open'
        };
        state.positions.unshift(pos);
        setBalance(balance() - stake);
        saveStore();

        toast('Prediction placed: ' + pos.asset + ' ' + (pos.direction === 'UP' ? 'up' : 'down') + ' with ' + fmtSOL(stake) + ' SOL. Settles at ' + fmtTime(pos.end) + '.', 'success');
        state.direction = null;
        renderMarket();
        renderSlip();
        renderPositions();
        renderWallet();
    }

    // ---------------------------------------------------------------- settlement
    function settleDue() {
        var now = Date.now();
        state.positions.forEach(function (p) {
            if (p.status !== 'open' || p.end > now || state.settling[p.id]) return;
            state.settling[p.id] = true;

            var finalize = function (finalPrice) {
                var pool = poolFor(p.asset, p.tf, p.start, p.end);
                var outcome = finalPrice > p.strike ? 'UP' : finalPrice < p.strike ? 'DOWN' : 'FLAT';
                p.final = finalPrice;
                p.settledAt = Date.now();
                if (outcome === 'FLAT') {
                    p.status = 'refunded';
                    p.payout = p.stake;
                } else if (outcome === p.direction) {
                    p.status = 'won';
                    p.payout = Math.round(p.stake * multiplier(pool, p.direction) * 1e6) / 1e6;
                } else {
                    p.status = 'lost';
                    p.payout = 0;
                }
                if (p.payout > 0) {
                    var cur = typeof state.balances[p.wallet] === 'number' ? state.balances[p.wallet] : START_BALANCE;
                    state.balances[p.wallet] = Math.round((cur + p.payout) * 1e6) / 1e6;
                }
                delete state.settling[p.id];
                saveStore();
                renderWallet();
                renderPositions();
                renderLeaderboard();
                if (state.wallet && state.wallet.address === p.wallet) {
                    var msg = p.status === 'won' ? 'You won ' + fmtSOL(p.payout, 3) + ' SOL on ' + p.asset + ' ' + TIMEFRAMES[p.tf].label + '.'
                        : p.status === 'lost' ? 'Your ' + p.asset + ' ' + TIMEFRAMES[p.tf].label + ' prediction missed. Final price ' + fmtUSD(finalPrice) + '.'
                        : 'Your ' + p.asset + ' round closed flat, so your stake was refunded.';
                    toast(msg, p.status === 'lost' ? 'error' : 'success');
                }
            };

            var useLive = function () {
                var live = state.prices[p.asset].price;
                if (live) finalize(live); else delete state.settling[p.id];
            };

            if (state.feed === 'sim') { useLive(); return; }
            priceAt(p.asset, p.end).then(finalize).catch(function () {
                // Candle may not exist yet; retry for up to 3 minutes, then use the live price.
                if (Date.now() - p.end > 3 * MIN) useLive();
                else delete state.settling[p.id];
            });
        });
    }

    function renderPositions() {
        var list = $('positions-list');
        if (!state.wallet) {
            list.innerHTML = '<p class="positions-empty">Connect a wallet to see your positions.</p>';
            return;
        }
        var mine = state.positions.filter(function (p) { return p.wallet === state.wallet.address; });
        var open = mine.filter(function (p) { return p.status === 'open'; });
        var settled = mine.filter(function (p) { return p.status !== 'open'; })
            .sort(function (a, b) { return (b.settledAt || 0) - (a.settledAt || 0); })
            .slice(0, 6);

        if (!open.length && !settled.length) {
            list.innerHTML = '<p class="positions-empty">No positions yet. Pick up or down on any market to place your first prediction.</p>';
            return;
        }
        var now = Date.now();
        list.innerHTML = open.concat(settled).map(function (p) {
            var dirCls = p.direction === 'UP' ? 'up' : 'down';
            var head = esc(p.asset) + ' ' + esc(TIMEFRAMES[p.tf].label) + ', ' + (p.direction === 'UP' ? 'Up' : 'Down');
            var status, statusCls, sub;
            if (p.status === 'open') {
                var live = state.prices[p.asset].price;
                var winning = live != null && (p.direction === 'UP' ? live > p.strike : live < p.strike);
                statusCls = live == null ? '' : winning ? 'winning' : 'losing';
                status = p.end <= now ? 'Settling' : live == null ? 'Open' : winning ? 'Winning' : 'Losing';
                sub = '<span>' + fmtSOL(p.stake) + ' SOL at ' + esc(fmtUSD(p.strike)) + '</span><span>' + (p.end > now ? fmtDuration(p.end - now) : '--') + '</span>';
            } else {
                statusCls = p.status;
                status = p.status === 'won' ? '+' + fmtSOL(p.payout - p.stake, 3) + ' SOL'
                    : p.status === 'lost' ? '-' + fmtSOL(p.stake, 3) + ' SOL' : 'Refunded';
                sub = '<span>Strike ' + esc(fmtUSD(p.strike)) + '</span><span>Final ' + esc(fmtUSD(p.final)) + '</span>';
            }
            return '<div class="pos ' + dirCls + (p.status !== 'open' ? ' settled' : '') + '">' +
                '<div class="pos-top"><span>' + head + '</span><span class="pos-status ' + statusCls + '">' + status + '</span></div>' +
                '<div class="pos-bottom">' + sub + '</div></div>';
        }).join('');
    }

    function resetDemo() {
        if (!state.wallet) { toast('Connect a wallet first.', 'info'); return; }
        if (!window.confirm('Reset your demo balance to ' + START_BALANCE + ' SOL and clear your positions?')) return;
        var addr = state.wallet.address;
        state.positions = state.positions.filter(function (p) { return p.wallet !== addr; });
        state.balances[addr] = START_BALANCE;
        saveStore();
        renderWallet();
        renderPositions();
        renderLeaderboard();
        renderMarket();
        toast('Demo reset. Balance is back to ' + START_BALANCE + ' SOL.', 'success');
    }

    // ---------------------------------------------------------------- leaderboard
    function renderLeaderboard() {
        var day = new Date().toISOString().slice(0, 10);
        var r = rng(hashStr('leaders|' + day));
        var rows = [];
        var pnl = 180 + r() * 220;
        for (var i = 0; i < 8; i++) {
            rows.push({ addr: shortAddr(randomAddress(r)), pnl: pnl, you: false });
            pnl *= 0.62 + r() * 0.25;
        }
        if (state.wallet) {
            var start = new Date(day + 'T00:00:00Z').getTime();
            var mine = 0;
            state.positions.forEach(function (p) {
                if (p.wallet === state.wallet.address && p.status !== 'open' && p.settledAt >= start) mine += (p.payout || 0) - p.stake;
            });
            if (mine > rows[rows.length - 1].pnl) {
                rows.push({ addr: 'You', pnl: mine, you: true });
                rows.sort(function (a, b) { return b.pnl - a.pnl; });
                rows = rows.slice(0, 8);
            }
        }
        $('leaderboard').innerHTML = rows.map(function (x) {
            return '<li' + (x.you ? ' class="is-you"' : '') + '><span class="leader-addr">' + esc(x.addr) +
                '</span><span class="leader-pnl">+' + fmtSOL(x.pnl) + ' SOL</span></li>';
        }).join('');
    }

    // ---------------------------------------------------------------- market UI
    function buildTabs() {
        $('asset-tabs').innerHTML = SYMBOLS.map(function (s) {
            return '<button type="button" class="seg" role="tab" data-asset="' + s + '" aria-selected="false">' +
                '<i class="' + ASSETS[s].icon + '" aria-hidden="true"></i>' + esc(ASSETS[s].name) + '</button>';
        }).join('');
        $('tf-tabs').innerHTML = TF_KEYS.map(function (k) {
            return '<button type="button" class="seg" role="tab" data-tf="' + k + '" aria-selected="false">' + esc(TIMEFRAMES[k].label) + '</button>';
        }).join('');
        $('ticker').innerHTML = SYMBOLS.map(function (s) {
            return '<button type="button" class="tick" data-asset="' + s + '">' +
                '<span class="tick-sym">' + s + '</span><span class="tick-price num">--</span><span class="tick-chg num">--</span></button>';
        }).join('');
    }

    function syncTabs() {
        Array.prototype.forEach.call(document.querySelectorAll('#asset-tabs .seg'), function (b) {
            b.setAttribute('aria-selected', String(b.dataset.asset === state.asset));
        });
        Array.prototype.forEach.call(document.querySelectorAll('#tf-tabs .seg'), function (b) {
            b.setAttribute('aria-selected', String(b.dataset.tf === state.tf));
        });
        Array.prototype.forEach.call(document.querySelectorAll('#ticker .tick'), function (b) {
            b.classList.toggle('is-active', b.dataset.asset === state.asset);
        });
    }

    function renderTicker() {
        Array.prototype.forEach.call(document.querySelectorAll('#ticker .tick'), function (b) {
            var p = state.prices[b.dataset.asset];
            b.querySelector('.tick-price').textContent = fmtUSD(p.price);
            var chg = b.querySelector('.tick-chg');
            chg.textContent = p.change24 == null ? '--' : fmtPct(p.change24);
            chg.className = 'tick-chg num' + (p.change24 > 0 ? ' up' : p.change24 < 0 ? ' down' : '');
        });
    }

    var lastShownPrice = null;

    function renderMarket() {
        var a = ASSETS[state.asset];
        var cfg = TIMEFRAMES[state.tf];
        var now = Date.now();
        var round = roundOf(state.tf, now);
        var left = round.end - now;
        var locked = left <= LOCK_MS;

        $('market-title').textContent = a.name + ', ' + cfg.long + ' round';
        $('market-question').textContent = 'Will ' + state.asset + ' close above the strike when this round ends at ' + fmtTime(round.end, cfg.ms >= 24 * HOUR) + '?';

        $('countdown').textContent = fmtDuration(left);
        var ring = $('ring-fill');
        var circ = 2 * Math.PI * 19;
        ring.style.strokeDasharray = circ.toFixed(2);
        ring.style.strokeDashoffset = (circ * (1 - left / cfg.ms)).toFixed(2);
        document.querySelector('.countdown').classList.toggle('closing', locked);

        var live = state.prices[state.asset].price;
        var priceEl = $('live-price');
        priceEl.textContent = fmtUSD(live);
        if (lastShownPrice != null && live != null && live !== lastShownPrice) {
            var cls = live > lastShownPrice ? 'flash-up' : 'flash-down';
            priceEl.classList.remove('flash-up', 'flash-down');
            priceEl.classList.add(cls);
            clearTimeout(renderMarket.flashTimer);
            renderMarket.flashTimer = setTimeout(function () { priceEl.classList.remove('flash-up', 'flash-down'); }, 700);
        }
        lastShownPrice = live;

        var strike = currentStrike(state.asset, state.tf);
        $('strike-price').textContent = strike ? fmtUSD(strike.price) : '--';
        $('strike-note').textContent = !strike ? 'Loading strike price'
            : strike.approx ? 'First price seen this round' : 'Price when this round opened at ' + fmtTime(round.start, cfg.ms >= 24 * HOUR);

        var diff = $('live-diff');
        if (strike && live) {
            var d = ((live - strike.price) / strike.price) * 100;
            diff.textContent = fmtPct(d) + ' vs strike';
            diff.className = 'delta' + (d > 0 ? ' up' : d < 0 ? ' down' : '');
        } else {
            diff.textContent = '--';
            diff.className = 'delta';
        }

        var pool = poolFor(state.asset, state.tf, round.start, now);
        var upPct = pool.total ? (pool.up / pool.total) * 100 : 50;
        $('up-pct').textContent = upPct.toFixed(0) + '%';
        $('down-pct').textContent = (100 - upPct).toFixed(0) + '%';
        $('pool-fill').style.width = upPct.toFixed(1) + '%';
        $('pool-total').textContent = fmtSOL(pool.total) + ' SOL';
        $('up-mult').textContent = multiplier(pool, 'UP').toFixed(2) + 'x payout';
        $('down-mult').textContent = multiplier(pool, 'DOWN').toFixed(2) + 'x payout';
        $('up-pool').textContent = fmtSOL(pool.up) + ' SOL staked';
        $('down-pool').textContent = fmtSOL(pool.down) + ' SOL staked';

        Array.prototype.forEach.call(document.querySelectorAll('.bet-btn'), function (b) {
            b.setAttribute('aria-pressed', String(state.direction === b.dataset.direction));
            b.disabled = locked;
        });
        $('lock-note').textContent = locked
            ? 'This round is closed to new predictions. The next round opens in ' + fmtDuration(left) + '.'
            : 'Predictions close 30 seconds before the round ends. Winners split the losing pool, minus a 3% fee.';
        if (locked && state.direction) { state.direction = null; renderSlip(); }
    }

    function selectMarket(asset, tf) {
        var changed = false;
        if (asset && asset !== state.asset) { state.asset = asset; changed = true; }
        if (tf && tf !== state.tf) { state.tf = tf; changed = true; }
        if (!changed) return;
        state.direction = null;
        lastShownPrice = null;
        state.lastRoundStart = roundOf(state.tf).start;
        saveStore();
        syncTabs();
        renderMarket();
        renderSlip();
        loadChart();
        loadHistory(true);
    }

    // ---------------------------------------------------------------- toasts
    function toast(msg, type) {
        type = type || 'info';
        var icon = type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info';
        var el = document.createElement('div');
        el.className = 'toast ' + type;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.innerHTML = '<i class="fa-solid ' + icon + '" aria-hidden="true"></i><span></span>';
        el.querySelector('span').textContent = msg;
        var host = $('toasts');
        host.appendChild(el);
        while (host.children.length > 3) host.removeChild(host.firstChild);
        setTimeout(function () {
            el.classList.add('leaving');
            setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
        }, 4500);
    }

    // ---------------------------------------------------------------- events
    function bindEvents() {
        $('asset-tabs').addEventListener('click', function (e) {
            var b = e.target.closest('[data-asset]');
            if (b) selectMarket(b.dataset.asset, null);
        });
        $('ticker').addEventListener('click', function (e) {
            var b = e.target.closest('[data-asset]');
            if (b) selectMarket(b.dataset.asset, null);
        });
        $('tf-tabs').addEventListener('click', function (e) {
            var b = e.target.closest('[data-tf]');
            if (b) selectMarket(null, b.dataset.tf);
        });
        Array.prototype.forEach.call(document.querySelectorAll('.bet-btn'), function (b) {
            b.addEventListener('click', function () { selectDirection(b.dataset.direction); });
        });
        $('wallet-btn').addEventListener('click', function () {
            if (state.wallet) disconnectWallet(); else connectWallet();
        });
        $('stake-input').addEventListener('input', function () { slipError(''); renderSlip(); });
        $('max-btn').addEventListener('click', function () {
            $('stake-input').value = state.wallet ? Math.floor(balance() * 100) / 100 : 0;
            renderSlip();
        });
        $('quick-stakes').addEventListener('click', function (e) {
            var b = e.target.closest('[data-stake]');
            if (!b) return;
            $('stake-input').value = b.dataset.stake;
            slipError('');
            renderSlip();
        });
        $('confirm-btn').addEventListener('click', placePrediction);
        $('clear-slip-btn').addEventListener('click', function () {
            state.direction = null;
            slipError('');
            renderMarket();
            renderSlip();
        });
        $('reset-btn').addEventListener('click', resetDemo);

        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function () { drawChart(); }).observe(canvas);
        } else {
            window.addEventListener('resize', drawChart);
        }
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) { renderMarket(); drawChart(); settleDue(); }
        });
        window.addEventListener('storage', function (e) {
            if (e.key !== STORE_KEY) return;
            var s = loadStore();
            state.positions = s.positions || state.positions;
            state.balances = s.balances || state.balances;
            renderPositions();
            renderWallet();
        });
    }

    // ---------------------------------------------------------------- main loop
    function everySecond() {
        var start = roundOf(state.tf).start;
        if (state.lastRoundStart !== null && start !== state.lastRoundStart) {
            toast('A new ' + TIMEFRAMES[state.tf].label + ' ' + state.asset + ' round just opened.', 'info');
            loadHistory(true);
        }
        state.lastRoundStart = start;
        renderMarket();
        renderPositions();
        if (state.direction) renderSlip();
        drawChart();
    }

    function init() {
        canvas = $('price-chart');
        ctx = canvas.getContext('2d');
        $('year').textContent = new Date().getFullYear();

        buildTabs();
        syncTabs();
        bindEvents();
        renderWallet();
        renderSlip();
        renderPositions();
        renderLeaderboard();
        renderMarket();
        restoreWallet();
        watchPhantom();

        state.lastRoundStart = roundOf(state.tf).start;
        pollPrices();
        pollStats();
        setInterval(pollStats, 60 * 1000);
        loadChart();
        setInterval(function () { loadChart(true); }, 2 * 60 * 1000);
        loadHistory(true);
        setInterval(everySecond, 1000);
        setInterval(settleDue, 5000);
        setInterval(renderLeaderboard, 60 * 1000);
        settleDue();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
