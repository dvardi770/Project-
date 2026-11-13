<?php
/**
 * Plugin Name:       Jewelry Builder
 * Description:       Adds the ring builder to your store. Place it on any page with the [jewelry_builder_widget] shortcode.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Requires Plugins:  woocommerce
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       jewelry-builder
 *
 * @package JewelryBuilder
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

define( 'JEWELRY_BUILDER_VERSION', '1.0.0' );
define( 'JEWELRY_BUILDER_OPTION', 'jewelry_builder_settings' );
define( 'JEWELRY_BUILDER_FILE', __FILE__ );

/**
 * The plugin.
 *
 * It does three things: stores the connection settings, registers the widget
 * script, and renders the <jewelry-configurator> element where the shortcode
 * is placed. The ring builder itself is a web component that talks to the
 * Jewelry Builder API from the shopper's browser; no shopper data passes
 * through WordPress.
 */
final class Jewelry_Builder_Plugin {

	const SCRIPT_HANDLE = 'jewelry-configurator';
	const SHORTCODE     = 'jewelry_builder_widget';
	const SETTINGS_PAGE = 'jewelry-builder';

	/**
	 * Singleton instance.
	 *
	 * @var Jewelry_Builder_Plugin|null
	 */
	private static $instance = null;

	/**
	 * Boot the plugin once.
	 *
	 * @return Jewelry_Builder_Plugin
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Register hooks.
	 */
	private function __construct() {
		add_action( 'init', array( $this, 'register_shortcode' ) );
		add_action( 'wp_enqueue_scripts', array( $this, 'register_script' ) );
		add_filter( 'script_loader_tag', array( $this, 'defer_script' ), 10, 2 );
		add_action( 'before_woocommerce_init', array( $this, 'declare_woocommerce_compatibility' ) );

		if ( is_admin() ) {
			add_action( 'admin_menu', array( $this, 'add_settings_page' ) );
			add_action( 'admin_init', array( $this, 'register_settings' ) );
			add_action( 'admin_notices', array( $this, 'admin_notices' ) );
			add_filter( 'plugin_action_links_' . plugin_basename( JEWELRY_BUILDER_FILE ), array( $this, 'action_links' ) );
		}
	}

	/* --------------------------------------------------------------------
	 * Settings
	 * ------------------------------------------------------------------ */

	/**
	 * Stored settings merged over defaults.
	 *
	 * @return array{api_base:string,api_key:string,script_url:string,go_to_cart:bool}
	 */
	public function get_settings() {
		$defaults = array(
			'api_base'   => '',
			'api_key'    => '',
			'script_url' => '',
			'go_to_cart' => false,
		);
		$stored   = get_option( JEWELRY_BUILDER_OPTION, array() );
		return array_merge( $defaults, is_array( $stored ) ? $stored : array() );
	}

	/**
	 * True once the API address and key have been entered.
	 *
	 * @return bool
	 */
	public function is_configured() {
		$settings = $this->get_settings();
		return '' !== $settings['api_base'] && '' !== $settings['api_key'];
	}

	/**
	 * URL of the widget script: the configured one, or the API's own copy.
	 *
	 * @return string
	 */
	public function get_script_url() {
		$settings = $this->get_settings();
		if ( '' !== $settings['script_url'] ) {
			return $settings['script_url'];
		}
		return '' === $settings['api_base'] ? '' : $settings['api_base'] . '/widget/jewelry-configurator.js';
	}

	/**
	 * Validate and clean the settings form before it is saved.
	 *
	 * @param mixed $input Raw form values.
	 * @return array
	 */
	public function sanitize_settings( $input ) {
		$input = is_array( $input ) ? $input : array();
		$clean = array(
			'api_base'   => '',
			'api_key'    => '',
			'script_url' => '',
			'go_to_cart' => ! empty( $input['go_to_cart'] ),
		);

		foreach ( array( 'api_base', 'script_url' ) as $field ) {
			$url = isset( $input[ $field ] ) ? trim( (string) $input[ $field ] ) : '';
			if ( '' === $url ) {
				continue;
			}
			$url = esc_url_raw( untrailingslashit( $url ), array( 'https' ) );
			if ( '' === $url ) {
				add_settings_error( JEWELRY_BUILDER_OPTION, $field, __( 'Addresses must start with https://.', 'jewelry-builder' ) );
				continue;
			}
			$clean[ $field ] = $url;
		}

		$key = isset( $input['api_key'] ) ? sanitize_text_field( (string) $input['api_key'] ) : '';
		if ( '' !== $key && 0 === strpos( $key, 'sk_' ) ) {
			// A secret key in page source would hand the store's API access to every visitor.
			add_settings_error( JEWELRY_BUILDER_OPTION, 'api_key', __( 'That is a secret key. Enter the publishable key, which starts with pk_.', 'jewelry-builder' ) );
		} elseif ( '' !== $key && ! preg_match( '/^[A-Za-z0-9_\-]{8,200}$/', $key ) ) {
			add_settings_error( JEWELRY_BUILDER_OPTION, 'api_key', __( 'The key contains characters that are not allowed.', 'jewelry-builder' ) );
		} else {
			$clean['api_key'] = $key;
		}

		return $clean;
	}

	/**
	 * Register the option with the Settings API.
	 */
	public function register_settings() {
		register_setting(
			self::SETTINGS_PAGE,
			JEWELRY_BUILDER_OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( $this, 'sanitize_settings' ),
				'default'           => array(),
			)
		);
	}

	/**
	 * Add the settings screen under WooCommerce (or Settings without it).
	 */
	public function add_settings_page() {
		$parent = class_exists( 'WooCommerce' ) ? 'woocommerce' : 'options-general.php';
		add_submenu_page(
			$parent,
			__( 'Jewelry Builder', 'jewelry-builder' ),
			__( 'Jewelry Builder', 'jewelry-builder' ),
			'manage_options',
			self::SETTINGS_PAGE,
			array( $this, 'render_settings_page' )
		);
	}

	/**
	 * Address of the settings screen.
	 *
	 * @return string
	 */
	private function settings_url() {
		return admin_url( 'admin.php?page=' . self::SETTINGS_PAGE );
	}

	/**
	 * "Settings" link on the Plugins screen.
	 *
	 * @param string[] $links Existing links.
	 * @return string[]
	 */
	public function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( $this->settings_url() ) . '">' . esc_html__( 'Settings', 'jewelry-builder' ) . '</a>' );
		return $links;
	}

	/**
	 * Tell the store owner what is still missing.
	 */
	public function admin_notices() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		if ( ! class_exists( 'WooCommerce' ) ) {
			echo '<div class="notice notice-warning"><p>' . esc_html__( 'Jewelry Builder needs WooCommerce to add rings to the cart. Please install and activate WooCommerce.', 'jewelry-builder' ) . '</p></div>';
			return;
		}
		if ( ! $this->is_configured() ) {
			printf(
				'<div class="notice notice-info"><p>%s <a href="%s">%s</a></p></div>',
				esc_html__( 'Jewelry Builder is almost ready.', 'jewelry-builder' ),
				esc_url( $this->settings_url() ),
				esc_html__( 'Enter your API address and key.', 'jewelry-builder' )
			);
		}
	}

	/**
	 * The settings screen.
	 */
	public function render_settings_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings = $this->get_settings();
		$host     = wp_parse_url( home_url(), PHP_URL_HOST );
		$name     = JEWELRY_BUILDER_OPTION;
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Jewelry Builder', 'jewelry-builder' ); ?></h1>
			<?php settings_errors( JEWELRY_BUILDER_OPTION ); ?>
			<form method="post" action="options.php">
				<?php settings_fields( self::SETTINGS_PAGE ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="jb-api-base"><?php esc_html_e( 'API address', 'jewelry-builder' ); ?></label></th>
						<td>
							<input name="<?php echo esc_attr( $name ); ?>[api_base]" id="jb-api-base" type="url" class="regular-text code" placeholder="https://api.example.com" value="<?php echo esc_attr( $settings['api_base'] ); ?>" required />
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="jb-api-key"><?php esc_html_e( 'Publishable key', 'jewelry-builder' ); ?></label></th>
						<td>
							<input name="<?php echo esc_attr( $name ); ?>[api_key]" id="jb-api-key" type="text" class="regular-text code" placeholder="pk_live_…" value="<?php echo esc_attr( $settings['api_key'] ); ?>" autocomplete="off" spellcheck="false" required />
							<p class="description">
								<?php
								printf(
									/* translators: %s: this site's domain name. */
									esc_html__( 'The key only works from domains registered for your account. This site is %s.', 'jewelry-builder' ),
									'<code>' . esc_html( (string) $host ) . '</code>'
								);
								?>
							</p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="jb-script-url"><?php esc_html_e( 'Widget script address', 'jewelry-builder' ); ?></label></th>
						<td>
							<input name="<?php echo esc_attr( $name ); ?>[script_url]" id="jb-script-url" type="url" class="regular-text code" value="<?php echo esc_attr( $settings['script_url'] ); ?>" />
							<p class="description"><?php esc_html_e( 'Optional. Leave empty to load the script from the API address.', 'jewelry-builder' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'After adding to cart', 'jewelry-builder' ); ?></th>
						<td>
							<label>
								<input name="<?php echo esc_attr( $name ); ?>[go_to_cart]" type="checkbox" value="1" <?php checked( $settings['go_to_cart'] ); ?> />
								<?php esc_html_e( 'Take the shopper straight to the cart', 'jewelry-builder' ); ?>
							</label>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>

			<h2><?php esc_html_e( 'Add the ring builder to a page', 'jewelry-builder' ); ?></h2>
			<p><?php esc_html_e( 'Edit any page and insert this shortcode where the builder should appear:', 'jewelry-builder' ); ?></p>
			<p><code>[<?php echo esc_html( self::SHORTCODE ); ?>]</code></p>
			<p class="description"><?php esc_html_e( 'A full-width page template gives the builder the most room.', 'jewelry-builder' ); ?></p>
		</div>
		<?php
	}

	/* --------------------------------------------------------------------
	 * Front end
	 * ------------------------------------------------------------------ */

	/**
	 * Register (not enqueue) the widget script. It is only loaded on pages
	 * that actually contain the shortcode.
	 */
	public function register_script() {
		$url = $this->get_script_url();
		if ( '' === $url ) {
			return;
		}
		wp_register_script( self::SCRIPT_HANDLE, $url, array(), JEWELRY_BUILDER_VERSION, true );
	}

	/**
	 * Load the widget script with `defer` so it never blocks the page.
	 *
	 * @param string $tag    The <script> tag.
	 * @param string $handle Script handle.
	 * @return string
	 */
	public function defer_script( $tag, $handle ) {
		if ( self::SCRIPT_HANDLE !== $handle || false !== strpos( $tag, ' defer' ) ) {
			return $tag;
		}
		return str_replace( ' src=', ' defer src=', $tag );
	}

	/**
	 * Register the shortcode.
	 */
	public function register_shortcode() {
		add_shortcode( self::SHORTCODE, array( $this, 'render_shortcode' ) );
	}

	/**
	 * Render [jewelry_builder_widget].
	 *
	 * Attributes:
	 *   go_to_cart  "yes" or "no"; overrides the setting for this placement.
	 *   class       Extra CSS class for the wrapper.
	 *
	 * @param array|string $atts Shortcode attributes.
	 * @return string
	 */
	public function render_shortcode( $atts ) {
		$atts = shortcode_atts(
			array(
				'go_to_cart' => '',
				'class'      => '',
			),
			$atts,
			self::SHORTCODE
		);

		if ( ! $this->is_configured() ) {
			// Shoppers see nothing; the store owner sees what to fix.
			if ( current_user_can( 'manage_options' ) ) {
				return '<p><a href="' . esc_url( $this->settings_url() ) . '">' . esc_html__( 'Jewelry Builder: enter your API address and key to show the ring builder here.', 'jewelry-builder' ) . '</a></p>';
			}
			return '';
		}

		$settings = $this->get_settings();

		if ( ! wp_script_is( self::SCRIPT_HANDLE, 'registered' ) ) {
			$this->register_script();
		}
		wp_enqueue_script( self::SCRIPT_HANDLE );

		// WooCommerce's own add-to-cart script provides the AJAX address the widget
		// posts to, and cart fragments refresh the mini-cart afterwards. Neither is
		// loaded on ordinary pages unless asked for.
		if ( class_exists( 'WooCommerce' ) ) {
			wp_enqueue_script( 'wc-add-to-cart' );
			wp_enqueue_script( 'wc-cart-fragments' );
		}

		$go_to_cart = '' === $atts['go_to_cart']
			? (bool) $settings['go_to_cart']
			: in_array( strtolower( (string) $atts['go_to_cart'] ), array( 'yes', 'true', '1' ), true );

		$locale  = str_replace( '_', '-', function_exists( 'determine_locale' ) ? determine_locale() : get_locale() );
		$classes = trim( 'jewelry-builder-widget ' . implode( ' ', array_map( 'sanitize_html_class', preg_split( '/\s+/', (string) $atts['class'], -1, PREG_SPLIT_NO_EMPTY ) ) ) );

		return sprintf(
			'<div class="%1$s"><jewelry-configurator api-base="%2$s" api-key="%3$s" platform="woocommerce" locale="%4$s"%5$s></jewelry-configurator></div>',
			esc_attr( $classes ),
			esc_url( $settings['api_base'], array( 'https' ) ),
			esc_attr( $settings['api_key'] ),
			esc_attr( $locale ),
			$go_to_cart ? ' go-to-cart' : ''
		);
	}

	/**
	 * The plugin stores nothing on orders, so it is safe with WooCommerce's
	 * high-performance order storage.
	 */
	public function declare_woocommerce_compatibility() {
		if ( class_exists( '\Automattic\WooCommerce\Utilities\FeaturesUtil' ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', JEWELRY_BUILDER_FILE, true );
		}
	}
}

Jewelry_Builder_Plugin::instance();
