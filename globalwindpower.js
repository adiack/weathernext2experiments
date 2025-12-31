/** Experimental code
 * @fileoverview GLOBAL WIND POWER POTENTIAL (2025)
 * * Metric: Mean Wind Power Density (W/m²) at 100m height.
 * * Equation: P = 0.5 * rho * v^3 (assuming rho = 1.225 kg/m^3 for air density).
 License: MIT
 */

// =========================================
// 1. CONFIGURATION & CONSTANTS
// =========================================

// Clip latitudes to avoid polar distortion artifacts in Web Mercator
var REGION = ee.Geometry.BBox(-180, -85, 180, 85); 
var DATE_RANGE = { start: '2025-01-01', end: '2025-12-31' };

// Visualization Parameters
var VIS_POWER = {
  min: 0, 
  max: 1500, 
  palette: ['000000', '0000FF', '00FFFF', '00FF00', 'FFFF00', 'FF0000', 'FF00FF']
};

// =========================================
// 2. STATIC ASSETS
// =========================================

// Land/Water Mask (MODIS) - Inverted to show water as dark
var landWater = ee.Image('MODIS/006/MOD44W/2015_01_01').select(['water_mask']);
var waterMask = landWater.eq(1); // 1 = Water

// Country Boundaries (FAO)
var worldVectors = ee.FeatureCollection("FAO/GAUL/2015/level0");
var outlineImage = ee.Image().paint(worldVectors, 1, 1).visualize({palette: ['FFFFFF']});

// Base Maps
var oceanBase = ee.Image(0).visualize({palette: ['202020']});
var landBase  = ee.Image(0).visualize({palette: ['404040']});

// =========================================
// 3. PHYSICS ENGINE
// =========================================

var rawCollection = ee.ImageCollection('projects/gcp-public-data-weathernext/assets/weathernext_2_0_0')
    .filter(ee.Filter.eq('ensemble_member', '8'))
    .select(['100m_u_component_of_wind', '100m_v_component_of_wind']);

/**
 * Calculates Wind Power Density (W/m^2).
 * P = 0.5 * rho * v^3
 * Constant 0.6125 derived from standard air density (1.225 kg/m^3).
 */
var calcPower = function(img) {
  // FIX 1: Explicit Type Cast
  img = ee.Image(img);
  
  // FIX 2: Single Server-Side Expression for performance & stability
  // "hypot" is replaced by sqrt(u^2 + v^2) inside the expression
  var power = img.expression(
    '0.6125 * ((u**2 + v**2)**1.5)', {
      'u': img.select(['100m_u_component_of_wind']),
      'v': img.select(['100m_v_component_of_wind'])
    }
  ).rename('wind_power_density');

  return power.copyProperties(img, ['system:time_start']);
};

// =========================================
// 4. AGGREGATION
// =========================================

// A. Full Year (Heavy Computation - For Export)
var exportMean = rawCollection
    .filterDate(DATE_RANGE.start, DATE_RANGE.end)
    .map(calcPower)
    .mean();

// B. July Preview (Lighter Computation - For Map)
// We only compute one month for the interactive map to prevent timeouts
var previewMean = rawCollection
    .filterDate('2025-07-01', '2025-07-31')
    .map(calcPower)
    .mean();

// =========================================
// 5. COMPOSITING
// =========================================

// Function to blend layers: Base -> Data -> Outlines
var createComposite = function(dataLayer) {
  var dataVis = dataLayer.visualize(VIS_POWER);
  // Stack: Ocean -> Land -> Data (masked to land?) -> Outlines
  // Actually, usually we want data everywhere.
  // Let's do: Dark Background -> Data -> Country Lines
  return ee.ImageCollection([
    oceanBase, 
    dataVis, 
    outlineImage
  ]).mosaic();
};

var mapComposite = createComposite(previewMean);
var exportComposite = createComposite(exportMean);

// =========================================
// 6. EXPORT
// =========================================

Export.image.toDrive({
  image: exportComposite,
  description: 'Global_WindPower_Density_2025',
  scale: 10000, // ~10km/px
  region: REGION,
  maxPixels: 1e11, // 100 Billion pixels allowed
  fileFormat: 'GeoTIFF'
});

// =========================================
// 7. UI & LEGEND
// =========================================

Map.setCenter(20, 0, 3);
Map.addLayer(mapComposite, {}, 'Wind Power (July Preview)');

// UI Panel
var legend = ui.Panel({
  style: {
    position: 'bottom-left', 
    padding: '8px 15px', 
    backgroundColor: 'rgba(255, 255, 255, 0.9)'
  }
});

legend.add(ui.Label({
  value: 'Mean Wind Power Density (100m)',
  style: {fontWeight: 'bold', fontSize: '14px', margin: '0 0 4px 0'}
}));

// Gradient Bar
var gradientImg = ee.Image.pixelLonLat().select(0).int();
var gradientThumb = ui.Thumbnail({
  image: gradientImg,
  params: {
    bbox: [0, 0, 100, 10], 
    dimensions: '200x20', 
    format: 'png',
    min: 0, 
    max: 100, 
    palette: VIS_POWER.palette
  },
  style: {stretch: 'horizontal', margin: '5px 0'}
});
legend.add(gradientThumb);

// Labels
legend.add(ui.Panel({
  widgets: [
    ui.Label('0', {margin: '4px 8px'}),
    ui.Label('750 W/m²', {margin: '4px 8px', textAlign: 'center', stretch: 'horizontal'}),
    ui.Label('> 1500', {margin: '4px 8px'})
  ],
  layout: ui.Panel.Layout.Flow('horizontal')
}));

legend.add(ui.Label({
  value: 'Note: Map displays July 2025. Run Export task for full annual mean.',
  style: {fontSize: '10px', color: '#555', margin: '4px 0'}
}));

Map.add(legend);
