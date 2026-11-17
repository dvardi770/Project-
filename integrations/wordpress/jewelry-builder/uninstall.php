<?php
/**
 * Runs when the plugin is deleted from the Plugins screen.
 *
 * @package JewelryBuilder
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'jewelry_builder_settings' );
