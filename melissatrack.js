/** Experimental code for Google Earth Engine
 * STORM MELISSA (2025) - Forecast Validation Analysis.
 * * "The Prophecy View": Visualizes a specific initialization run (Oct 23)
 * * against the verified ground truth path (IBTrACS).
 * License: MIT
 */

// =========================================
// 1. CONFIGURATION & CONSTANTS
// =========================================

var REGION = ee.Geometry.Rectangle([-90.0, 10.0, -40.0, 42.0]);

var MODEL_INIT_DATE = '2025-10-23'; 
// Filter strictly for the midnight initialization run
var INIT_FILTER = ee.Filter.and(
    ee.Filter.date(MODEL_INIT_DATE, ee.Date(MODEL_INIT_DATE).advance(1, 'day')),
    ee.Filter.stringContains('start_time', 'T00:00:00')
);

// Visualization Styles
var VIS_FORECAST = {
  min: 15, // m/s (approx 30 knots)
  max: 60, // m/s (approx 115 knots)
  palette: ['blue', 'cyan', 'yellow', 'red', 'magenta', 'white'],
  opacity: 0.5
};

var VIS_TRACK = {
  min: 0, 
  max: 5, // Saffir-Simpson Category
  palette: ['00FFFF', 'FFFF00', 'FFA500', 'FF0000', '8B0000', 'FF00FF']
};

var TRACK_THICKNESS = 4;

// =========================================
// 2. GROUND TRUTH DATA (IBTrACS)
// =========================================

var bestTrackData = [
  {t: '2025-10-17T12:00:00', lat: 10.6, lon: -41.5, cat: 0},
  {t: '2025-10-18T00:00:00', lat: 11.2, lon: -45.5, cat: 0},
  {t: '2025-10-19T00:00:00', lat: 12.3, lon: -55.1, cat: 0},
  {t: '2025-10-20T00:00:00', lat: 13.2, lon: -63.0, cat: 0},
  {t: '2025-10-21T06:00:00', lat: 14.0, lon: -70.0, cat: 1}, // TS Status
  {t: '2025-10-22T06:00:00', lat: 14.0, lon: -73.5, cat: 1},
  {t: '2025-10-24T06:00:00', lat: 16.0, lon: -75.5, cat: 1},
  {t: '2025-10-25T12:00:00', lat: 16.3, lon: -75.0, cat: 2},
  {t: '2025-10-26T06:00:00', lat: 16.3, lon: -76.1, cat: 3}, // Major Hurricane
  {t: '2025-10-27T06:00:00', lat: 16.3, lon: -77.7, cat: 4},
  {t: '2025-10-28T06:00:00', lat: 16.9, lon: -78.4, cat: 5},
  {t: '2025-10-28T15:00:00', lat: 17.9, lon: -78.0, cat: 5}, // PEAK (Jamaica)
  {t: '2025-10-29T09:00:00', lat: 20.2, lon: -76.1, cat: 3}, // Cuba
  {t: '2025-10-30T06:00:00', lat: 24.9, lon: -73.9, cat: 2}, // Bahamas
  {t: '2025-10-31T06:00:00', lat: 34.4, lon: -65.6, cat: 1},
  {t: '2025-10-31T18:00:00', lat: 40.6, lon: -58.9, cat: 0}  // Extratropical
];

// Construct Features
// We create two collections:
// 1. Segments: For drawing the colorful line.
// 2. Points: For the "Current Location" dot logic.
var segments = [];
var points = [];

for (var i = 0; i < bestTrackData.length - 1; i++) {
  var p1 = bestTrackData[i];
  var p2 = bestTrackData[i+1];
  
  // Create Line Segment
  segments.push(ee.Feature(
    ee.Geometry.LineString([[p1.lon, p1.lat], [p2.lon, p2.lat]]), 
    {
      'system:time_start': ee.Date(p1.t).millis(),
      'system:time_end': ee.Date(p2.t).millis(), // Important for filtering
      'cat': p1.cat
    }
  ));
  
  // Create Point
  points.push(ee.Feature(
      ee.Geometry.Point([p1.lon, p1.lat]), 
      {'system:time_start': ee.Date(p1.t).millis()}
  ));
}

var trackSegments = ee.FeatureCollection(segments);
var trackPoints = ee.FeatureCollection(points);

// =========================================
// 3. STATIC BACKGROUND
// =========================================

// Pre-render the static background once to avoid re-computing per frame
var background = ee.ImageCollection([
  ee.Image(0).visualize({palette: ['010409']}), // Black Sea
  ee.Image().paint(ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017'), 1).gt(0)
    .visualize({palette: ['2a2a2a'], opacity: 1}) // Dark Land
]).mosaic();

// =========================================
// 4. FORECAST DATA & JOIN
// =========================================

var forecastCol = ee.ImageCollection('projects/gcp-public-data-weathernext/assets/weathernext_2_0_0')
    .filter(INIT_FILTER)
    .select(['100m_u_component_of_wind', '100m_v_component_of_wind']);

// OPTIMIZATION: Use a MaxDifference Join to find the ground truth point
// that matches the forecast timestamp.
// This avoids running a filter inside the map loop.
var timeFilter = ee.Filter.maxDifference({
  difference: 6 * 60 * 60 * 1000, // Match within +/- 6 hours
  leftField: 'system:time_start',
  rightField: 'system:time_start'
});

var saveBestJoin = ee.Join.saveBest('matched_truth_point', 'system:time_start');
var joinedCol = saveBestJoin.apply(forecastCol, trackPoints, timeFilter);

// =========================================
// 5. FRAME COMPOSITION
// =========================================

var processFrame = function(img) {
  // 1. CRITICAL FIX: Cast the generic element to an ee.Image
  img = ee.Image(img);

  var currentTime = ee.Date(img.get('system:time_start'));
  var currentMillis = currentTime.millis();

  // A. Forecast Layer (The "Prophecy")
  // Now .expression() will work because 'img' is strictly defined as an Image
  var speed = img.expression(
    'sqrt(u**2 + v**2)', {
      'u': img.select(['100m_u_component_of_wind']),
      'v': img.select(['100m_v_component_of_wind'])
    }
  ).resample('bicubic'); 
                 
  var forecastLayer = speed.updateMask(speed.gte(15))
                           .visualize(VIS_FORECAST);

  // B. Historical Track Layer
  var pastTrack = trackSegments.filter(ee.Filter.lt('system:time_start', currentMillis));
  var trackLayer = ee.Image().paint(pastTrack, 'cat', TRACK_THICKNESS)
                             .visualize(VIS_TRACK);

  // C. Current Location Dot
  var truthFeature = ee.Feature(img.get('matched_truth_point'));
  
  var dotLayer = ee.Algorithms.If(
    truthFeature,
    ee.Image().paint(ee.FeatureCollection([truthFeature]), 1, 8).visualize({palette: 'ffffff'}),
    ee.Image(0).visualize({opacity: 0}) 
  );

  // D. Composite
  return ee.ImageCollection([background, forecastLayer, trackLayer, ee.Image(dotLayer)])
      .mosaic()
      .set('system:time_start', currentMillis);
};

var frames = ee.ImageCollection(joinedCol.map(processFrame)).sort('system:time_start');

// =========================================
// 6. EXPORT
// =========================================

Export.video.toDrive({
  collection: frames,
  description: 'Melissa_Forecast_Oct23',
  dimensions: 1080,
  framesPerSecond: 24,
  region: REGION,
  maxFrames: 5000
});

// =========================================
// 7. PREVIEW
// =========================================

Map.setCenter(-70.0, 22.0, 4);
Map.addLayer(background, {}, 'Base Map');
Map.addLayer(ee.Image().paint(trackSegments, 'cat', 2).visualize(VIS_TRACK), {}, 'Full Ground Truth Track');
print('Script Ready. Run the Export task to generate the validation video.');
