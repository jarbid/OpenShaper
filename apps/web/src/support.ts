/**
 * Optional "support the project" donation link (Buy Me a Coffee) shown in the toolbar.
 *
 * OpenShaper is free and open-source — this is a voluntary tip jar, never a
 * paywall or a gate on any feature.
 *
 * To turn it on, set BMC_HANDLE to your Buy Me a Coffee username — i.e. the
 * `<handle>` in buymeacoffee.com/<handle>. Leave it '' (empty) and the Support
 * link is hidden, so nothing broken ships before you've filled in a real handle.
 */
export const BMC_HANDLE = 'jaredg';

/** Donation URL, derived from the handle. Empty when no handle is set. */
export const SUPPORT_URL = BMC_HANDLE ? `https://www.buymeacoffee.com/${BMC_HANDLE}` : '';

/** Toolbar label for the donation link. */
export const SUPPORT_LABEL = '♥ Support';
