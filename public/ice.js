// Ice types (ESI group 465) and what each is valued as.
// Compressing ice is 1:1, so every unit mined is worth one unit of its compressed type.
// Azure Ice and Crystalline Icicle have no compressed form, so they use their own price.
export const ICE = {
  16264: { name: 'Blue Ice', value: 28433 },
  17975: { name: 'Blue Ice IV-Grade', value: 28443 },
  16262: { name: 'Clear Icicle', value: 28434 },
  17978: { name: 'Clear Icicle IV-Grade', value: 28436 },
  16267: { name: 'Dark Glitter', value: 28435 },
  16268: { name: 'Gelidus', value: 28437 },
  16263: { name: 'Glacial Mass', value: 28438 },
  17977: { name: 'Glacial Mass IV-Grade', value: 28442 },
  16266: { name: 'Glare Crust', value: 28439 },
  16269: { name: 'Krystallos', value: 28440 },
  16265: { name: 'White Glaze', value: 28444 },
  17976: { name: 'White Glaze IV-Grade', value: 28441 },
  28627: { name: 'Azure Ice', value: 28627 },
  28628: { name: 'Crystalline Icicle', value: 28628 },
};
export const PRICED = {
  28433: 'Compressed Blue Ice', 28443: 'Compressed Blue Ice IV-Grade', 28434: 'Compressed Clear Icicle',
  28436: 'Compressed Clear Icicle IV-Grade', 28435: 'Compressed Dark Glitter', 28437: 'Compressed Gelidus',
  28438: 'Compressed Glacial Mass', 28442: 'Compressed Glacial Mass IV-Grade', 28439: 'Compressed Glare Crust',
  28440: 'Compressed Krystallos', 28444: 'Compressed White Glaze', 28441: 'Compressed White Glaze IV-Grade',
  28627: 'Azure Ice', 28628: 'Crystalline Icicle',
};
export const PRICE_SOURCES = ['Jita Buy', 'Jita Sell'];

// Ice products, for valuing ice the way refining buybacks do.
export const PRODUCTS = {
  16272: 'Heavy Water', 16273: 'Liquid Ozone', 16275: 'Strontium Clathrates',
  16274: 'Helium Isotopes', 17889: 'Hydrogen Isotopes', 17888: 'Nitrogen Isotopes', 17887: 'Oxygen Isotopes',
};
// Reprocessing output of one unit of ice (raw or compressed, same thing), before yield.
const STD = (iso, n) => ({ 16272: 69, 16273: 35, 16275: 1, [iso]: n });
const IV = iso => ({ 16272: 104, 16273: 55, 16275: 1, [iso]: 483 });
export const MATERIALS = {
  16264: STD(17887, 414), 17975: IV(17887),   // Blue Ice: oxygen
  16262: STD(16274, 414), 17978: IV(16274),   // Clear Icicle: helium
  16263: STD(17889, 414), 17977: IV(17889),   // Glacial Mass: hydrogen
  16265: STD(17888, 414), 17976: IV(17888),   // White Glaze: nitrogen
  16266: { 16272: 1381, 16273: 691, 16275: 35 },  // Glare Crust
  16267: { 16272: 691, 16273: 1381, 16275: 69 },  // Dark Glitter
  16268: { 16272: 345, 16273: 691, 16275: 104 },  // Gelidus
  16269: { 16272: 173, 16273: 691, 16275: 173 },  // Krystallos
  // Azure Ice and Crystalline Icicle: no published refine data here, so a buyback comparison treats them as not accepted.
};
// Refining buybacks to compare against: each pays a percentage of the refined value of the ice
// (ice products at Jita, after the refine yield). Ice a buyback doesn't take counts as 0 for it.
// method: 'refined' = % of the ice products it refines into; 'compressed' = % of the compressed ice's own price.
// market: where the ice products (refined method) are priced. basis: 'Jita Buy' = buy orders, 'Jita Sell' = sell orders
// (the names are kept from when Jita was the only market).
export const BUYBACK_DEFAULTS = { enabled: true, name: 'Buyback', short: 'BB', method: 'refined', market: 'Jita', percentage: 90, yield: 90.6, basis: 'Jita Buy', accepted: [], note: '' };
// Markets ice products can be priced in. Jita: Jita 4-4 first. Others: public orders in that one trade structure.
export const MARKETS = {
  Jita: { label: 'Jita', region: 10000002, system: 30000142 },
  'C-J6MT': { label: 'C-J6MT', place: '1st Taj Mahgoon', region: 10000009, system: 30000772, location: 1049588174021 },
};
export const BUYBACK_METHODS = { refined: 'refined value (ice products)', compressed: 'compressed ice price' };
export const DEFAULT_BUYBACKS = [
  { ...BUYBACK_DEFAULTS, name: 'KarmaFleet Buyback', short: 'KFBP', percentage: 70,
    accepted: [16264, 17975, 16262, 17978, 16263, 17977, 16265, 17976],
    note: 'From a KarmaFleet quote on 2026-11-22: 70% of refined value at Jita buy. Dark Glitter, Glare Crust and Gelidus were not accepted; Krystallos is assumed the same. A 90.6% yield matched their per-unit price to within about 0.5%.' },
  { ...BUYBACK_DEFAULTS, name: 'Blackwater Task Forces Ice Buyback', short: 'BWTF', method: 'refined', market: 'C-J6MT', percentage: 92, yield: 90.63,
    accepted: [16267, 16268, 16266, 16269, 17977],
    note: '92% of the reprocessed buy value at C-J6MT prices (forum post, price fixed 10 Oct 2026), for compressed Dark Glitter, Gelidus, Glare Crust, Krystallos and Glacial Mass IV-Grade. Contract to Skafan, 5 days minimum. Their appraisal tool (innomin.at) uses a 90.63% yield and also shows a 5% processing fee.' },
];
export const BUYBACK_BASES = ['Jita Buy', 'Jita Sell'];
// fallback_prices: per market, a price to use for an ice product when that market has no buy order for it.
// Strontium at C-J6MT preset from an innomin.at appraisal (23 Nov 2026), which used 2,327 ISK there before its 92%.
export const DEFAULT_SETTINGS = { price_source: 'Jita Buy', percentage: 95, session_gap_minutes: 30, fallback_prices: { 'C-J6MT': { 16275: 2327 } } };
export const POLL_MINUTES = 10;
