export function enableZoom(imgElement) {
  let scale = 1;
  let panning = false;
  let pointX = 0;
  let pointY = 0;
  let startX = 0;
  let startY = 0;

  function setTransform() {
    imgElement.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
  }

  imgElement.addEventListener('mousedown', function (e) {
    e.preventDefault();
    if (scale === 1) return; // Don't pan if not zoomed
    startX = e.clientX - pointX;
    startY = e.clientY - pointY;
    panning = true;
    imgElement.style.cursor = 'grabbing';
  });

  window.addEventListener('mouseup', function () {
    panning = false;
    if (scale > 1) {
      imgElement.style.cursor = 'grab';
    } else {
      imgElement.style.cursor = 'zoom-in';
    }
  });

  window.addEventListener('mousemove', function (e) {
    if (!panning) return;
    pointX = e.clientX - startX;
    pointY = e.clientY - startY;
    setTransform();
  });

  imgElement.addEventListener('dblclick', function (e) {
    e.preventDefault();
    if (scale > 1) {
      // Zoom out
      scale = 1;
      pointX = 0;
      pointY = 0;
      imgElement.style.cursor = 'zoom-in';
    } else {
      // Zoom in
      const xs = (e.clientX - pointX) / scale;
      const ys = (e.clientY - pointY) / scale;
      scale = 3;
      pointX = e.clientX - xs * scale;
      pointY = e.clientY - ys * scale;
      imgElement.style.cursor = 'grab';
    }
    setTransform();
  });

  imgElement.addEventListener('wheel', function (e) {
    e.preventDefault();
    const xs = (e.clientX - pointX) / scale;
    const ys = (e.clientY - pointY) / scale;
    const delta = e.deltaY > 0 ? -1 : 1;
    
    // Zoom factor
    if (delta > 0) {
      scale *= 1.2;
    } else {
      scale /= 1.2;
    }

    // Restrict scale
    if (scale < 1) scale = 1;
    if (scale > 10) scale = 10;

    if (scale === 1) {
      pointX = 0;
      pointY = 0;
      imgElement.style.cursor = 'zoom-in';
    } else {
      pointX = e.clientX - xs * scale;
      pointY = e.clientY - ys * scale;
      imgElement.style.cursor = 'grab';
    }

    setTransform();
  });

  // Reset function to be attached to the element so we can call it when image changes
  imgElement.resetZoom = function() {
    scale = 1;
    pointX = 0;
    pointY = 0;
    setTransform();
    imgElement.style.cursor = 'zoom-in';
  };

  imgElement.getZoomState = function() {
    return { scale, pointX, pointY };
  };

  imgElement.setZoomState = function(state) {
    if (!state) return;
    scale = state.scale || 1;
    pointX = state.pointX || 0;
    pointY = state.pointY || 0;
    setTransform();
    if (scale > 1) {
      imgElement.style.cursor = 'grab';
    } else {
      imgElement.style.cursor = 'zoom-in';
    }
  };

  imgElement.isZoomed = function() {
    return scale > 1;
  };
  
  imgElement.style.cursor = 'zoom-in';
  imgElement.style.transformOrigin = '0 0';
}
