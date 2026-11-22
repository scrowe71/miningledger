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
export const DEFAULT_SETTINGS = { price_source: 'Jita Buy', percentage: 95, session_gap_minutes: 30 };
export const POLL_MINUTES = 10;
