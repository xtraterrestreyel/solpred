# SolPred

Crypto prediction markets for BTC, ETH, SOL and DOGE. Pick a round length (15 min to 24 hours) and predict whether the price closes above or below the strike.

## How it works

- Live prices come from the Coinbase Exchange public API, with CoinGecko as a fallback. If both are unreachable the app switches to a simulated feed and keeps retrying.
- The strike for each round is the price at the minute the round opened.
- Pools are parimutuel: winners split the losing side, minus a 3% fee. Crowd liquidity is simulated.
- Predictions use paper SOL (10 SOL starting balance) and are saved in the browser. Phantom wallet connects if installed; otherwise a demo wallet is created.

## Files

- `index.html` - page structure
- `styles.css` - styling
- `app.js` - all app logic (price feed, rounds, chart, slip, settlement)

## Run locally

Open `index.html` in a browser. Some browsers block API calls from `file://` pages, so for live prices run a local server:

```
python -m http.server 8000
```

Then open http://localhost:8000

## Deploy

Hosted on GitHub Pages from the `main` branch root. The `CNAME` file holds the custom domain.
