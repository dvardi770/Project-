=== Jewelry Builder ===
Requires at least: 5.8
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Adds a ring builder to your WooCommerce store.

== Description ==

Shoppers choose a setting, pick a diamond from live inventory, and add the finished ring to the cart.

Place the builder on any page with the shortcode:

`[jewelry_builder_widget]`

Optional attributes: `go_to_cart="yes"` to send the shopper to the cart after adding, and `class="..."` for an extra CSS class.

The builder runs in the shopper's browser and loads inventory and prices from the Jewelry Builder service at the API address you enter. The plugin itself sends no shopper data anywhere.

== Installation ==

1. Upload the `jewelry-builder` folder to `/wp-content/plugins/`, or install the zip from Plugins > Add New > Upload.
2. Activate the plugin. WooCommerce must be active.
3. Go to WooCommerce > Jewelry Builder and enter the API address and publishable key from your Jewelry Builder account. Your site's domain must be registered for the key.
4. Add `[jewelry_builder_widget]` to a page.

So that paid orders reach production, add a webhook under WooCommerce > Settings > Advanced > Webhooks: topic "Order updated", with the delivery URL and secret from your Jewelry Builder account.

== Changelog ==

= 1.0.0 =
* First release.
