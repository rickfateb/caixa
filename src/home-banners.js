export const BANNER_POSITIONS = ['UPPER', 'CENTER_UPPER', 'CENTER_LOWER', 'LOWER'];

export function bannerDisplay(settings) {
  return {
    upperCount: settings.upper_count,
    lowerCount: settings.lower_count,
    centerUpperCount: settings.center_upper_count,
    centerLowerCount: settings.center_lower_count,
    transitionSeconds: settings.transition_seconds,
    order: 'RANDOM_NO_IMMEDIATE_REPEAT',
    productShowcase: {
      positions: ['CENTER_UPPER', 'CENTER_LOWER'],
      when: 'NO_ELIGIBLE_BANNER',
      transitionSeconds: 3,
      source: 'CATALOG_PRODUCTS_WITH_IMAGE',
      fields: ['image_url', 'description'],
      order: 'RANDOM_NO_IMMEDIATE_REPEAT'
    }
  };
}

// The caller has already applied activation, dates and store eligibility.
export function limitHomeBanners(eligible, settings) {
  const limits = {
    UPPER: settings.upper_count, LOWER: settings.lower_count,
    CENTER_UPPER: settings.center_upper_count, CENTER_LOWER: settings.center_lower_count
  };
  const counts = Object.fromEntries(BANNER_POSITIONS.map(position => [position, 0]));
  return eligible.filter(banner => {
    const position = banner.position || 'UPPER';
    return BANNER_POSITIONS.includes(position) && counts[position]++ < limits[position];
  });
}
