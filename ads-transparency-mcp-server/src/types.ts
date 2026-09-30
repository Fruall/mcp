import type { AudienceCategory, CreativeFormat, Platform } from "./constants.js";

/** A Google-rounded range, e.g. impressions "175000–200000" or ad counts "4000–5000". */
export interface Range {
  lower: number;
  upper: number;
}

export interface AdvertiserSuggestion {
  advertiser_id: string;
  name: string;
  country: string | null;
  ads_count: Range | null;
}

export interface Suggestions {
  advertisers: AdvertiserSuggestion[];
  domains: string[];
}

export interface Advertiser {
  advertiser_id: string;
  name: string;
  legal_name: string | null;
  disclosed_name: string | null;
  country: string | null;
  location: string | null;
  identity_verified: boolean;
}

export type PreviewKind = "image" | "render";

export interface Preview {
  kind: PreviewKind;
  /** Static image of the ad (search ads are usually served as a rendered PNG). */
  image_url?: string;
  width?: number;
  height?: number;
  /** Script that renders the ad; parsed on demand for text, YouTube ID or images. */
  render_url?: string;
}

export interface CreativeSummary {
  advertiser_id: string;
  advertiser_name: string;
  creative_id: string;
  format: CreativeFormat | "unknown";
  first_shown: string | null;
  last_shown: string | null;
  days_shown: number | null;
  domain: string | null;
  preview: Preview | null;
  url: string;
}

export interface CreativePage {
  creatives: CreativeSummary[];
  next_cursor: string | null;
  total_estimate: Range | null;
}

export interface PlatformImpressions {
  platform: Platform | "unknown";
  impressions: Range;
}

export interface RegionStats {
  region_code: string;
  region_name: string;
  first_shown: string | null;
  /** True when the ad started before 2023-03-01 (first_shown is then that date, a lower bound). */
  first_shown_clipped: boolean;
  last_shown: string | null;
  /** Null when Google publishes no impression data for this region (outside EEA/Turkey, or not yet available). */
  impressions: Range | null;
  impressions_counted_since: string | null;
  impressions_available_from: string | null;
  impressions_by_platform: PlatformImpressions[];
}

export type AudienceUse = "included" | "excluded" | "included_and_excluded" | "unused";

export interface TextAd {
  headline: string | null;
  display_url: string | null;
  description: string | null;
}

export interface CreativeVariant {
  kind: PreviewKind;
  image_url?: string;
  width?: number;
  height?: number;
  render_url?: string;
  /** Present when the render script exposes the text (a minority of search ads). */
  text?: TextAd;
  youtube_video_id?: string;
  youtube_url?: string;
  /** Additional images referenced by the render script (display/Demand Gen ads). */
  asset_images?: string[];
}

export interface CreativeDetail {
  advertiser_id: string;
  advertiser_name: string | null;
  creative_id: string;
  format: CreativeFormat | "unknown";
  last_shown_at: string | null;
  topic: { id: number; label: string } | null;
  audience_selection: Record<AudienceCategory, AudienceUse> | null;
  totals: Omit<RegionStats, "region_code" | "region_name"> | null;
  regions: RegionStats[];
  variants: CreativeVariant[];
  url: string;
}
