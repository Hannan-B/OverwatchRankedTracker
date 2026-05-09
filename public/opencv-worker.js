// OpenCV Web Worker with detailed initialization logging

self.postMessage({ type: 'log', message: 'Worker started' });

try {
  self.postMessage({ type: 'log', message: 'Loading opencv.js via importScripts...' });
  importScripts('/opencv.js');
  self.postMessage({ type: 'log', message: 'importScripts completed' });
} catch (e) {
  self.postMessage({ type: 'log', message: 'importScripts FAILED: ' + e.message });
  self.postMessage({ type: 'error', error: 'Failed to load opencv.js: ' + e.message });
}

// Check what cv looks like after loading
self.postMessage({ type: 'log', message: 'typeof cv = ' + typeof cv });

if (typeof cv !== 'undefined') {
  self.postMessage({ type: 'log', message: 'cv exists, typeof cv.Mat = ' + typeof (cv.Mat) });
  self.postMessage({ type: 'log', message: 'cv keys sample: ' + Object.keys(cv).slice(0, 10).join(', ') });
  
  if (cv.Mat) {
    // Already ready
    self.postMessage({ type: 'log', message: 'OpenCV already initialized!' });
    self.postMessage({ type: 'ready' });
  } else if (typeof cv === 'function') {
    // cv is a factory function - need to call it
    self.postMessage({ type: 'log', message: 'cv is a function, calling it...' });
    try {
      cv = cv();
      self.postMessage({ type: 'log', message: 'cv() called, typeof cv.Mat = ' + typeof (cv.Mat) });
      if (cv.Mat) {
        self.postMessage({ type: 'ready' });
      } else {
        // Wait for async init
        self.postMessage({ type: 'log', message: 'Waiting for runtime init...' });
        cv.onRuntimeInitialized = function() {
          self.postMessage({ type: 'log', message: 'onRuntimeInitialized fired!' });
          self.postMessage({ type: 'ready' });
        };
      }
    } catch (e) {
      self.postMessage({ type: 'log', message: 'cv() call failed: ' + e.message });
    }
  } else if (typeof cv.onRuntimeInitialized !== 'undefined' || typeof cv === 'object') {
    // cv is an object, might need onRuntimeInitialized
    self.postMessage({ type: 'log', message: 'cv is object, setting onRuntimeInitialized' });
    
    // Check periodically if it's ready
    var checkCount = 0;
    var checkInterval = setInterval(function() {
      checkCount++;
      if (cv && cv.Mat) {
        clearInterval(checkInterval);
        self.postMessage({ type: 'log', message: 'OpenCV ready after ' + checkCount + ' checks' });
        self.postMessage({ type: 'ready' });
      } else if (checkCount > 300) { // 60 seconds
        clearInterval(checkInterval);
        self.postMessage({ type: 'log', message: 'Gave up waiting after 60s' });
        self.postMessage({ type: 'error', error: 'OpenCV init timeout in worker' });
      }
    }, 200);
    
    cv.onRuntimeInitialized = function() {
      self.postMessage({ type: 'log', message: 'onRuntimeInitialized callback fired!' });
      clearInterval(checkInterval);
      self.postMessage({ type: 'ready' });
    };
  }
} else {
  self.postMessage({ type: 'log', message: 'cv is undefined after importScripts' });
  self.postMessage({ type: 'error', error: 'cv not defined after loading opencv.js' });
}

// ============================================================
// MESSAGE HANDLER (processing functions)
// ============================================================

self.onmessage = function(e) {
  var data = e.data;
  
  if (data.type === 'ping') {
    self.postMessage({ type: 'pong', id: data.id, ready: !!(cv && cv.Mat) });
    return;
  }
  
  if (!(cv && cv.Mat)) {
    self.postMessage({ type: 'error', id: data.id, error: 'OpenCV not ready' });
    return;
  }

  try {
    if (data.type === 'detect_portraits') {
      var portraits = detectPortraits(data.imageData, data.width, data.height, data.pageType);
      self.postMessage({ type: 'portraits', id: data.id, portraits: portraits });
    }
    else if (data.type === 'orb_match') {
      var score = orbMatch(data.portraitData, data.bankData);
      self.postMessage({ type: 'orb_score', id: data.id, score: score });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, error: err.message });
  }
};

// ============================================================
// PROCESSING FUNCTIONS
// ============================================================

function detectPortraits(imageData, width, height, pageType) {
  var regionX1, regionX2, regionY1, regionY2;

  if (pageType === 'summary') {
    regionX1 = 0; regionX2 = Math.floor(width * 0.28);
    regionY1 = Math.floor(height * 0.20); regionY2 = Math.floor(height * 0.78);
  } else {
    regionX1 = Math.floor(width * 0.20); regionX2 = Math.floor(width * 0.40);
    regionY1 = Math.floor(height * 0.20); regionY2 = Math.floor(height * 0.50);
  }

  var regionW = regionX2 - regionX1;
  var regionH = regionY2 - regionY1;

  var fullMat = cv.matFromImageData(new ImageData(new Uint8ClampedArray(imageData), width, height));
  var region = fullMat.roi(new cv.Rect(regionX1, regionY1, regionW, regionH));

  var gray = new cv.Mat();
  var blurred = new cv.Mat();
  cv.cvtColor(region, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(9, 9), 3);

  var allCircles = [];
  var dpValues = [1.2, 1.5, 2.0];
  var p2Values = [30, 40, 50, 60];

  for (var di = 0; di < dpValues.length; di++) {
    for (var pi = 0; pi < p2Values.length; pi++) {
      var circles = new cv.Mat();
      try {
        cv.HoughCircles(blurred, circles, cv.HOUGH_GRADIENT, dpValues[di], 350, 100, p2Values[pi], 110, 210);
        for (var i = 0; i < circles.cols; i++) {
          var x = circles.data32F[i * 3];
          var y = circles.data32F[i * 3 + 1];
          var r = circles.data32F[i * 3 + 2];
          if (y > regionH * 0.15 && y < regionH * 0.85) {
            allCircles.push([Math.round(x), Math.round(y), Math.round(r)]);
          }
        }
      } catch (e) { }
      circles.delete();
    }
  }

  gray.delete(); blurred.delete();

  if (allCircles.length === 0) {
    region.delete(); fullMat.delete();
    return [];
  }

  allCircles.sort(function(a, b) { return a[1] - b[1]; });
  var groups = [[allCircles[0]]];
  for (var i = 1; i < allCircles.length; i++) {
    var lastGroup = groups[groups.length - 1];
    if (Math.abs(allCircles[i][1] - lastGroup[0][1]) < 250) {
      lastGroup.push(allCircles[i]);
    } else {
      groups.push([allCircles[i]]);
    }
  }

  var portraits = [];
  for (var gi = 0; gi < groups.length; gi++) {
    var group = groups[gi];
    if (group.length < 10) continue;

    var xs = group.map(function(c) { return c[0]; }).sort(function(a,b) { return a-b; });
    var ys = group.map(function(c) { return c[1]; }).sort(function(a,b) { return a-b; });
    var rs = group.map(function(c) { return c[2]; }).sort(function(a,b) { return a-b; });
    var x = xs[Math.floor(xs.length / 2)];
    var y = ys[Math.floor(ys.length / 2)];
    var r = rs[Math.floor(rs.length / 2)];

    var innerR = Math.floor(r * 0.55);
    var iy1 = Math.max(0, y - innerR);
    var iy2 = Math.min(regionH, y + innerR);
    var ix1 = Math.max(0, x - innerR);
    var ix2 = Math.min(regionW, x + innerR);

    var roi = region.roi(new cv.Rect(ix1, iy1, ix2 - ix1, iy2 - iy1));
    var meanVal = cv.mean(roi);
    var avgBrightness = (meanVal[0] + meanVal[1] + meanVal[2]) / 3;
    roi.delete();

    if (avgBrightness < 50) continue;

    var cropR = Math.floor(r * (pageType === 'breakdown' ? 0.80 : 0.65));
    var finalR = pageType === 'breakdown' ? Math.max(cropR, 140) : cropR;
    var cy1 = Math.max(0, y - finalR);
    var cy2 = Math.min(regionH, y + finalR);
    var cx1 = Math.max(0, x - finalR);
    var cx2 = Math.min(regionW, x + finalR);

    var portrait = region.roi(new cv.Rect(cx1, cy1, cx2 - cx1, cy2 - cy1));
    var rgba = new cv.Mat();
    cv.cvtColor(portrait, rgba, cv.COLOR_BGRA2RGBA);

    var portraitData = {
      data: Array.from(rgba.data),
      width: portrait.cols,
      height: portrait.rows,
    };
    portraits.push(portraitData);
    rgba.delete(); portrait.delete();
  }

  region.delete(); fullMat.delete();
  return portraits;
}

function orbMatch(portraitData, bankData) {
  var size = 128;
  var pMat = cv.matFromImageData(new ImageData(new Uint8ClampedArray(portraitData.data), portraitData.width, portraitData.height));
  var bMat = cv.matFromImageData(new ImageData(new Uint8ClampedArray(bankData.data), bankData.width, bankData.height));
  var pResized = new cv.Mat(); var bResized = new cv.Mat();
  cv.resize(pMat, pResized, new cv.Size(size, size));
  cv.resize(bMat, bResized, new cv.Size(size, size));
  var pGray = new cv.Mat(); var bGray = new cv.Mat();
  cv.cvtColor(pResized, pGray, cv.COLOR_RGBA2GRAY);
  cv.cvtColor(bResized, bGray, cv.COLOR_RGBA2GRAY);

  var score = 0;
  try {
    var orb = new cv.ORB(200);
    var kp1 = new cv.KeyPointVector(); var kp2 = new cv.KeyPointVector();
    var des1 = new cv.Mat(); var des2 = new cv.Mat();
    var mask = new cv.Mat();
    orb.detectAndCompute(pGray, mask, kp1, des1);
    orb.detectAndCompute(bGray, mask, kp2, des2);
    if (des1.rows >= 2 && des2.rows >= 2) {
      var bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
      var matches = new cv.DMatchVectorVector();
      bf.knnMatch(des1, des2, matches, 2);
      var goodCount = 0;
      for (var i = 0; i < matches.size(); i++) {
        var match = matches.get(i);
        if (match.size() >= 2 && match.get(0).distance < 0.75 * match.get(1).distance) goodCount++;
      }
      score = goodCount / Math.max(kp1.size(), 1);
      matches.delete();
    }
    kp1.delete(); kp2.delete(); des1.delete(); des2.delete(); mask.delete();
  } catch (e) { }

  pMat.delete(); bMat.delete(); pResized.delete(); bResized.delete(); pGray.delete(); bGray.delete();
  return score;
}
