# Practise on your own WordPress site

Practice mode runs the whole ring builder on your WordPress site with sample rings and sample
diamonds, so you can try it as a customer and as a jeweller before offering it to anyone:

- **8 ring designs**: solitaire, cathedral, bezel, pavé, halo, hidden halo, three stone, vintage.
  Each comes in white, yellow and rose gold and platinum, with photos, a 360° video and live 3D.
- **48 sample diamonds**: natural and lab-grown, in nine shapes, from 0.5 to 3 ct.
- **A starting markup** that you change in the dashboard.
- **Real orders through WooCommerce**, paid with "Cash on delivery", so no money moves.

Nothing in practice mode is a real stone. Certificates read `PRACTICE-…`, and the sample
diamonds never reach a supplier.

You need four things:
- your WordPress site, with WooCommerce for "Add to cart";
- a free Netlify site for the ring photos;
- a server for the ring builder (the steps below use Render.com);
- this repository on GitHub.

## 1. Put the ring photos online (Netlify)

1. Go to app.netlify.com/drop and drag in `ring-builder-site.zip`.
2. Netlify gives you an address such as `https://shiny-ring-123.netlify.app`.
3. Your photos address is that address followed by `/renders`, for example
   `https://shiny-ring-123.netlify.app/renders`.

The zip carries a `_headers` file that lets your WordPress site read the photo lists.

## 2. Start the server (Render.com)

1. Sign in at render.com with GitHub, then choose **New → Blueprint** and pick this repository.
   Render reads `render.yaml`. It creates a database, the server (`ring-builder-api`) and the
   dashboard (`ring-builder-dashboard`).
2. It asks for a few values:
   - **PRACTICE_SITE**: your WordPress address, e.g. `https://my-shop.com`.
   - **RENDERS_PUBLIC_URL**: the photos address from step 1.
   - **DASHBOARD_URL**: the dashboard's address. Render shows it as
     `https://ring-builder-dashboard.onrender.com` or similar. You can fill it in once that service exists.
   - **The four WooCommerce values**: leave them empty for now (step 4).
3. Wait for the first deploy, then open **ring-builder-api → Logs**. Near the top you'll find:

   ```
   Practice store ready for https://my-shop.com …
     Order webhook address for WooCommerce: <this server>/webhooks/woocommerce/1a2b3c…
   Keys (shown once, keep them somewhere safe):
     For the WordPress plugin:   pk_live_…
     To sign in to the dashboard: sk_live_…
   ```

   Copy both keys and the webhook address.

4. Note the server's address at the top of its page, e.g. `https://ring-builder-api.onrender.com`.

**Good to know about Render's free plan:**
- A free server goes to sleep when nobody uses it. The first visit after a pause can take about a minute.
- Free databases are temporary. Check Render's current terms. To practise for longer, choose a paid database.

## 3. Show the ring builder on WordPress

1. If WooCommerce isn't installed: **Plugins → Add New → WooCommerce → Install → Activate**.
   For practice, turn on **WooCommerce → Settings → Payments → Cash on delivery**.
2. **Plugins → Add New → Upload Plugin**, choose `jewelry-builder.zip`, then **Activate**.
3. **WooCommerce → Jewelry Builder**:
   - API address: the server address from step 2 (no slash at the end);
   - Publishable key: the `pk_live_…` key.
4. **Pages → Add New**, for example "Design your ring". Add a Shortcode block with
   `[jewelry_builder_widget]` and publish.
5. Open the page. You should see the eight rings with photos, then the diamonds, then the review
   with the 3D ring and the price.

## 4. Turn on "Add to cart" and orders

1. **A hidden product for custom rings.** In WordPress go to **Products → Add New**. Name it "Custom Ring",
   give it a regular price (any, e.g. 1), set **Catalog visibility: Hidden** and publish.
   The number after `post=` in the address bar is its ID.
2. **API keys.** Go to **WooCommerce → Settings → Advanced → REST API → Add key**. Choose a description and
   Permissions **Read/Write**, then **Generate API key**. Copy the Consumer key (`ck_…`) and the
   Consumer secret (`cs_…`).
3. **Webhook.** Go to **WooCommerce → Settings → Advanced → Webhooks → Add webhook** and fill in:
   - Status **Active**;
   - Topic **Order updated**;
   - Delivery URL: the webhook address from step 2, with your server's address in place of
     `<this server>`;
   - Secret: make up a long password and write it down.

   Save.
4. **Hand the values to the server.** On Render, in **ring-builder-api → Environment**, fill in:
   - `PRACTICE_WOO_KEY`: the `ck_…` key;
   - `PRACTICE_WOO_SECRET`: the `cs_…` secret;
   - `PRACTICE_WOO_PRODUCT_ID`: the product's ID;
   - `PRACTICE_WEBHOOK_SECRET`: the webhook secret.

   Save. The server restarts and the log says "WooCommerce: connected".

## 5. Practise

- **As a customer.** Design a ring on your page, "Add to cart", and check out with Cash on delivery.
  WooCommerce marks the order "Processing". That counts as paid, and the order appears in the dashboard.
- **As the jeweller.** Open the dashboard address and sign in with the `sk_live_…` key:
  - **Markup** changes your prices. The site shows them within a minute.
  - **Orders** lists the rings bought. You can send one to casting.

To start over, run `practice --reset` (see below) or let Render delete the database.

## Practise on your own computer instead

If you're comfortable with a terminal, you can run everything locally. Start with
Node 20, pnpm and PostgreSQL:

```
pnpm install
DATABASE_URL=postgresql://…/practice pnpm --filter @jewelry/db migrate:deploy
DATABASE_URL=… pnpm --filter @jewelry/api practice https://my-shop.com      # prints the keys
pnpm --filter @jewelry/widget build
DATABASE_URL=… BUNDLE_SIGNING_SECRET=… CREDENTIALS_ENCRYPTION_KEY=… \
  RENDERS_PUBLIC_URL=https://shiny-ring-123.netlify.app/renders pnpm dev:api
```

Your WordPress site has to reach the server over https, so a computer at home needs a tunnel
(for example Cloudflare Tunnel or ngrok). The Docker image (`infra/docker/Dockerfile`) runs the
same way anywhere Docker runs.

Other commands:

| Command | What it does |
|---|---|
| `practice <site> --new-keys` | issues fresh keys (the old ones keep working) |
| `practice --reset` | removes the practice store and its sample diamonds |

Practice mode refuses to run on a database that holds a real store or real diamonds. The
sample diamonds would show in every store, so it needs a database of its own.

## When you're ready for real customers

Start a separate server with its own database, so practice data never mixes with real data. Then:
- connect your Nivoda account (diamonds and prices become real);
- set up billing in the dashboard.

Real stores are added with `issue-key` and `set-credentials`; see the main README.
