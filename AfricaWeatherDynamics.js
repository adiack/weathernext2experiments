/** Experimental code for Google Earth Engine
 * @fileoverview AFRICA WEATHER DYNAMICS (2025) 
 * Visualization of Wind Speed and Precipitation using WeatherNext.
 */

// =========================================
// 1. CONFIGURATION & CONSTANTS
// =========================================

var REGION = ee.Geometry.Rectangle([-25.0, -40.0, 60.0, 40.0]); 
var DATE_RANGE = { start: '2025-01-01', end: '2025-12-01' };

// Visualization Parameters
var VIS_BASE = {
  palette: ['000000', '252525'], 
  min: 0, 
  max: 1
};

var VIS_WIND = {
  min: 1, 
  max: 18, 
  palette: ['000c36', '5caeff', 'bd93d8', 'ff7f50', 'fffdd0'], 
  opacity: 0.6
};

var VIS_RAIN = {
  min: 0.001, 
  max: 0.025, 
  palette: ['00FFFF', 'FF00FF', 'FFFFFF'], 
  opacity: 1.0
};

// =========================================
// 2. STATIC ASSETS
// =========================================

var srtm = ee.Image('CGIAR/SRTM90_V4');
var baseMap = srtm.gt(0).visualize(VIS_BASE);

// =========================================
// 3. DATA PROCESSING
// =========================================

// Load & Pre-select bands to optimize I/O
var collection = ee.ImageCollection('projects/gcp-public-data-weathernext/assets/weathernext_2_0_0')
    .filterDate(DATE_RANGE.start, DATE_RANGE.end)
    .filter(ee.Filter.eq('forecast_hour', 6))
    .filter(ee.Filter.eq('ensemble_member', '8'))
    // Select only what we need
    .select(['10m_u_component_of_wind', '10m_v_component_of_wind', 'total_precipitation_6hr']);

var processFrame = function(img) {
  // FIX 1: FORCE TYPE CAST (Crucial for .expression to work)
  img = ee.Image(img);
   
  // A. WIND (Calculated via Expression)
  // FIX 2: Use .expression() and strict list selectors ['...']
  var windSpeed = img.expression(
    'sqrt(u**2 + v**2)', {
      'u': img.select(['10m_u_component_of_wind']),
      'v': img.select(['10m_v_component_of_wind'])
    }
  );
   
  var windVis = windSpeed.updateMask(windSpeed.gte(1.0))
                         .visualize(VIS_WIND);

  // B. RAIN
  var rain = img.select(['total_precipitation_6hr']);
  var rainVis = rain.updateMask(rain.gte(0.001))
                    .visualize(VIS_RAIN);

  // C. COMPOSITE
  // Use image collection mosaic for z-ordering
  return ee.ImageCollection([baseMap, windVis, rainVis]).mosaic()
      .set('system:time_start', img.get('system:time_start'));
};

var frames = collection.map(processFrame);

// =========================================
// 4. EXPORT
// =========================================

Export.video.toDrive({
  collection: frames,
  description: 'Africa_Monsoon_Robust_2025',
  dimensions: 720,
  framesPerSecond: 24,
  region: REGION,
  maxFrames: 1500
});

// =========================================
// 5. PREVIEW
// =========================================

Map.setCenter(18.0, 0.0, 3);
Map.addLayer(baseMap, {}, 'Base Map');
Map.addLayer(frames.first(), {}, 'Composite Preview');

print('Status: Script optimized with strict typing and expression-based math.');
