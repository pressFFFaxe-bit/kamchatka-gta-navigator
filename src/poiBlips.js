// Generates crisp 24x24 CSS px (48x48 @2x) GTA San Andreas square radar blip icons

function drawBlipCanvas(drawIconFn) {
  const size = 48; // @2x for 24x24px display size
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Thick black border (2.5px CSS -> 5px @2x)
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  // Dark radar square interior
  ctx.fillStyle = '#141614';
  ctx.fillRect(5, 5, size - 10, size - 10);

  // Subtle inner pixel edge
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1;
  ctx.strokeRect(5.5, 5.5, size - 11, size - 11);

  drawIconFn(ctx, size);
  return ctx.getImageData(0, 0, size, size);
}

// Fuel pump icon (bright orange/yellow)
function drawFuelIcon(ctx) {
  ctx.fillStyle = '#ff9e1b';
  ctx.strokeStyle = '#ff9e1b';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Pump body
  ctx.fillRect(14, 13, 14, 22);
  // Pump screen cutout
  ctx.fillStyle = '#141614';
  ctx.fillRect(17, 16, 8, 6);

  // Top cap
  ctx.fillStyle = '#ffcc00';
  ctx.fillRect(13, 12, 16, 3);

  // Base
  ctx.fillStyle = '#ff9e1b';
  ctx.fillRect(12, 34, 18, 3);

  // Hose & nozzle
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(28, 20);
  ctx.lineTo(32, 20);
  ctx.lineTo(32, 31);
  ctx.lineTo(35, 31);
  ctx.lineTo(35, 16);
  ctx.lineTo(32, 14);
  ctx.stroke();
}

// Pay 'n' Spray wrench icon (white)
function drawServiceIcon(ctx) {
  ctx.save();
  ctx.translate(24, 24);
  ctx.rotate(-Math.PI / 4);

  ctx.fillStyle = '#f5f5f5';
  // Handle shaft
  ctx.fillRect(-3.2, -4, 6.4, 17);
  // Rounded bottom end
  ctx.beginPath();
  ctx.arc(0, 13, 3.2, 0, Math.PI * 2);
  ctx.fill();

  // Wrench head with C-jaw cutout
  ctx.beginPath();
  ctx.arc(0, -8.5, 7.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#141614';
  ctx.fillRect(-3, -17, 6, 8.5);
  ctx.restore();
}

// Burger Shot / Cluckin' Bell burger icon
function drawFoodIcon(ctx) {
  // Top bun
  ctx.fillStyle = '#f0a830';
  ctx.beginPath();
  ctx.arc(24, 20, 10, Math.PI, 0);
  ctx.closePath();
  ctx.fill();

  // Sesame seeds
  ctx.fillStyle = '#fff3c4';
  ctx.fillRect(20, 14, 2, 2);
  ctx.fillRect(25, 13, 2, 2);
  ctx.fillRect(27, 16, 2, 2);

  // Lettuce wave
  ctx.fillStyle = '#6ec94b';
  ctx.fillRect(13, 21, 22, 3);

  // Patty
  ctx.fillStyle = '#8c3b1e';
  ctx.fillRect(13, 25, 22, 4.5);

  // Cheese accent
  ctx.fillStyle = '#ffcc00';
  ctx.fillRect(15, 24, 18, 2);

  // Bottom bun
  ctx.fillStyle = '#e09624';
  ctx.fillRect(14, 30.5, 20, 4.5);
}

export function registerGtaPoiBlips(map) {
  const icons = {
    'blip-fuel': drawBlipCanvas(drawFuelIcon),
    'blip-service': drawBlipCanvas(drawServiceIcon),
    'blip-food': drawBlipCanvas(drawFoodIcon)
  };

  for (const [id, imageData] of Object.entries(icons)) {
    if (!map.hasImage(id)) {
      map.addImage(id, imageData, { pixelRatio: 2 });
    }
  }
}

export function getPoiCategoryMeta(poiClass) {
  if (poiClass === 'fuel') {
    return { category: 'АЗС', fallbackName: 'Автозаправка' };
  }
  if (['car_repair', 'car_wash', 'car'].includes(poiClass)) {
    return { category: 'АВТОСЕРВИС / СТО', fallbackName: 'Автосервис' };
  }
  return { category: 'КАФЕ / ЕДА', fallbackName: 'Кафе / Ресторан' };
}
