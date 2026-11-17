<?php
/**
 * Smoke test for the plugin without WordPress: loads it against minimal
 * stand-ins for the WordPress functions it calls, then checks the shortcode
 * output and the settings sanitiser.
 *
 *   php integrations/wordpress/tests/run.php
 *
 * This proves the file runs and escapes correctly. It does not replace
 * activating the plugin on a real WordPress + WooCommerce site.
 */

declare( strict_types=1 );

define( 'ABSPATH', __DIR__ . '/' );

$GLOBALS['wp'] = array(
	'options'    => array(),
	'shortcodes' => array(),
	'registered' => array(),
	'enqueued'   => array(),
	'errors'     => array(),
	'filters'    => array(),
	'is_admin'   => false,
	'can_manage' => false,
);

function add_action( $hook, $cb ) { $GLOBALS['wp']['filters'][ $hook ][] = $cb; }
function add_filter( $hook, $cb ) { $GLOBALS['wp']['filters'][ $hook ][] = $cb; }
function do_hook( $hook, ...$args ) { $value = $args[0] ?? null; foreach ( $GLOBALS['wp']['filters'][ $hook ] ?? array() as $cb ) { $value = $cb( ...$args ); } return $value; }
function add_shortcode( $tag, $cb ) { $GLOBALS['wp']['shortcodes'][ $tag ] = $cb; }
function shortcode_atts( $defaults, $atts ) { return array_merge( $defaults, array_intersect_key( (array) $atts, $defaults ) ); }
function get_option( $name, $default = false ) { return $GLOBALS['wp']['options'][ $name ] ?? $default; }
function is_admin() { return $GLOBALS['wp']['is_admin']; }
function current_user_can() { return $GLOBALS['wp']['can_manage']; }
function plugin_basename( $file ) { return basename( dirname( $file ) ) . '/' . basename( $file ); }
function admin_url( $path ) { return 'https://shop.test/wp-admin/' . $path; }
function wp_register_script( $handle, $src, $deps, $ver, $footer ) { $GLOBALS['wp']['registered'][ $handle ] = $src; }
function wp_script_is( $handle ) { return isset( $GLOBALS['wp']['registered'][ $handle ] ); }
function wp_enqueue_script( $handle ) { $GLOBALS['wp']['enqueued'][] = $handle; }
function add_settings_error( $setting, $code, $message ) { $GLOBALS['wp']['errors'][] = $code; }
function determine_locale() { return 'en_GB'; }
function __( $text ) { return $text; }
function esc_html__( $text ) { return htmlspecialchars( $text, ENT_QUOTES ); }
function esc_html( $text ) { return htmlspecialchars( (string) $text, ENT_QUOTES ); }
function esc_attr( $text ) { return htmlspecialchars( (string) $text, ENT_QUOTES ); }
function sanitize_text_field( $text ) { return trim( strip_tags( (string) $text ) ); }
function sanitize_html_class( $class ) { return preg_replace( '/[^A-Za-z0-9_-]/', '', $class ); }
function untrailingslashit( $text ) { return rtrim( $text, '/\\' ); }
function esc_url( $url, $protocols = array( 'http', 'https' ) ) {
	$scheme = parse_url( (string) $url, PHP_URL_SCHEME );
	return in_array( $scheme, $protocols, true ) ? htmlspecialchars( (string) $url, ENT_QUOTES ) : '';
}
function esc_url_raw( $url, $protocols = array( 'http', 'https' ) ) {
	$scheme = parse_url( (string) $url, PHP_URL_SCHEME );
	return in_array( $scheme, $protocols, true ) ? (string) $url : '';
}
class WooCommerce {}

require __DIR__ . '/../jewelry-builder/jewelry-builder.php';

$failures = 0;
function check( string $name, bool $ok ): void {
	global $failures;
	echo ( $ok ? '  ok   ' : '  FAIL ' ) . $name . "\n";
	if ( ! $ok ) { $failures++; }
}

$plugin = Jewelry_Builder_Plugin::instance();
do_hook( 'init' );
$shortcode = $GLOBALS['wp']['shortcodes']['jewelry_builder_widget'] ?? null;
check( 'registers the [jewelry_builder_widget] shortcode', is_callable( $shortcode ) );

// Not configured.
check( 'unconfigured: shoppers see nothing', '' === $shortcode( array() ) );
$GLOBALS['wp']['can_manage'] = true;
check( 'unconfigured: the owner sees a link to settings', false !== strpos( $shortcode( array() ), 'wp-admin/admin.php?page=jewelry-builder' ) );
$GLOBALS['wp']['can_manage'] = false;
check( 'unconfigured: no script is enqueued', array() === $GLOBALS['wp']['enqueued'] );

// Sanitiser.
$clean = $plugin->sanitize_settings( array( 'api_base' => ' https://api.example.com/ ', 'api_key' => 'pk_live_abcDEF123-_', 'script_url' => '', 'go_to_cart' => '1' ) );
check( 'sanitiser: trims the address and drops the trailing slash', 'https://api.example.com' === $clean['api_base'] );
check( 'sanitiser: keeps a valid publishable key', 'pk_live_abcDEF123-_' === $clean['api_key'] && true === $clean['go_to_cart'] );
$bad = $plugin->sanitize_settings( array( 'api_base' => 'http://insecure.example.com', 'api_key' => 'sk_live_secretsecret', 'script_url' => 'javascript:alert(1)' ) );
check( 'sanitiser: rejects non-https addresses', '' === $bad['api_base'] && '' === $bad['script_url'] );
check( 'sanitiser: refuses a secret key', '' === $bad['api_key'] && in_array( 'api_key', $GLOBALS['wp']['errors'], true ) );
$odd = $plugin->sanitize_settings( array( 'api_key' => 'pk_"><script>alert(1)</script>' ) );
check( 'sanitiser: refuses a key with markup in it', '' === $odd['api_key'] );
check( 'sanitiser: survives non-array input', '' === $plugin->sanitize_settings( 'x' )['api_base'] );

// Configured.
$GLOBALS['wp']['options']['jewelry_builder_settings'] = $clean;
do_hook( 'wp_enqueue_scripts' );
check( 'script defaults to the API\'s own copy', 'https://api.example.com/widget/jewelry-configurator.js' === ( $GLOBALS['wp']['registered']['jewelry-configurator'] ?? '' ) );
$html = $shortcode( array( 'class' => 'wide "><script>x</script>' ) );
check( 'renders the web component', false !== strpos( $html, '<jewelry-configurator api-base="https://api.example.com" api-key="pk_live_abcDEF123-_" platform="woocommerce" locale="en-GB" go-to-cart></jewelry-configurator>' ) );
check( 'escapes the class attribute', false === strpos( $html, '<script>' ) && false !== strpos( $html, 'class="jewelry-builder-widget wide scriptxscript"' ) );
check( 'enqueues the widget and WooCommerce cart scripts', array( 'jewelry-configurator', 'wc-add-to-cart', 'wc-cart-fragments' ) === $GLOBALS['wp']['enqueued'] );
check( 'go_to_cart="no" overrides the setting', false === strpos( $shortcode( array( 'go_to_cart' => 'no' ) ), 'go-to-cart' ) );
check( 'unknown shortcode attributes are ignored', false === strpos( $shortcode( array( 'onload' => 'x' ) ), 'onload' ) );

// Script tag.
$tag = do_hook( 'script_loader_tag', '<script src="https://api.example.com/widget/jewelry-configurator.js" id="jewelry-configurator-js"></script>', 'jewelry-configurator' );
check( 'adds defer to the widget script only', false !== strpos( $tag, '<script defer src=' ) && '<script src="x"></script>' === do_hook( 'script_loader_tag', '<script src="x"></script>', 'other' ) );

// A custom script URL.
$GLOBALS['wp']['options']['jewelry_builder_settings']['script_url'] = 'https://cdn.example.com/w.js';
check( 'a configured script address wins', 'https://cdn.example.com/w.js' === $plugin->get_script_url() );

echo $failures ? "\n$failures FAILED\n" : "\nall passed\n";
exit( $failures ? 1 : 0 );
