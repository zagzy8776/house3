/**
 * Adapter registry.
 *
 * Single place that maps a stored channel kind to an adapter instance. Any
 * channel that is not on the allow-list is rejected loudly.
 */

import { AffiliateRedirectAdapter } from './affiliateAdapter';
import { PartnerApiAdapter } from './partnerApiAdapter';
import { PartnerDashboardAdapter, type DashboardSource } from './dashboardAdapter';
import { IcalFeedAdapter } from './icalAdapter';
import {
  UnsupportedChannelError,
  type AuthorizationRecord,
  type InventoryChannelKind,
  type PartnerInventoryAdapter
} from './types';

/** Channels this platform will create a client for. Nothing else is permitted. */
export const SUPPORTED_CHANNELS: readonly InventoryChannelKind[] = [
  'PARTNER_API',
  'ICAL_FEED',
  'PARTNER_DASHBOARD',
  'AFFILIATE_PROGRAM'
];

export type ChannelConfig = {
  partnerId: string;
  channel: string;
  authorization: AuthorizationRecord | null;
  config: Record<string, string>;
};

export type RegistryDeps = {
  fetchImpl?: typeof fetch;
  dashboardSource?: DashboardSource;
};

export function isSupportedChannel(channel: string): channel is InventoryChannelKind {
  return (SUPPORTED_CHANNELS as readonly string[]).includes(channel);
}

export function createAdapter(input: ChannelConfig, deps: RegistryDeps = {}): PartnerInventoryAdapter {
  if (!isSupportedChannel(input.channel)) {
    throw new UnsupportedChannelError(input.channel);
  }

  if (input.authorization && input.authorization.partnerId !== input.partnerId) {
    throw new Error(
      `Authorization was granted to partner ${input.authorization.partnerId} but channel is registered to ${input.partnerId}`
    );
  }

  switch (input.channel) {
    case 'PARTNER_API':
      return new PartnerApiAdapter({
        authorization: input.authorization,
        fetchImpl: deps.fetchImpl,
        inventoryPath: input.config.inventoryPath,
        reservationPath: input.config.reservationPath
      });
    case 'ICAL_FEED':
      return new IcalFeedAdapter({ authorization: input.authorization, fetchImpl: deps.fetchImpl });
    case 'AFFILIATE_PROGRAM':
      return new AffiliateRedirectAdapter({ authorization: input.authorization, fetchImpl: deps.fetchImpl });
    case 'PARTNER_DASHBOARD': {
      if (!deps.dashboardSource) {
        throw new Error('PARTNER_DASHBOARD adapter requires a DashboardSource');
      }
      return new PartnerDashboardAdapter({
        authorization: input.authorization,
        source: deps.dashboardSource
      });
    }
  }
}
