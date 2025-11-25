# ¡Lo Siento! Visual Redesign

## Overview

This document captures requirements and design suggestions for implementing a new visual interface for Lo Siento using custom Figma-designed assets.

---

## Requirements

### 1. Asset Replacement
Replace existing CSS-drawn visuals (board grid, pawn shapes) with image-based assets from `frontend/future_assets/`.

### 2. Board Specifications
- **Dimensions**: 800×800 pixels
- **Tile size**: 50×50 pixel squares (49×49 white interior with 1px black border)
- **Layout**: Tiles arranged around the perimeter and into the safe zones, matching the existing game logic (60 track tiles + 5 safety tiles per player + home/start areas)
- **Start circles**: Larger than tile, center pawn in circle
- **Home stars**: Larger than tile, center pawn in star
- **Entire 50×50 area clickable** even though tile interior is 49×49

### 3. Pawn Specifications
- **Size constraint**: Pawns must fit within 50×50 tile area
- **Colors**: Red, blue, yellow, green (one per player seat)

### 4. Movement Animations
- **Standard movement**: Pawns traverse **each individual tile** in a rapid arching motion (parabolic curve upward between tiles)
- **Slide movement**: Pawns slide horizontally/vertically across slide tiles (linear motion, faster than arch)
- **Knockout animation**: When bumped (via ¡Lo Siento! or landing), the pawn spins (720° rotation) while returning to its start home area
- **7-split moves**: Both pawns animate **simultaneously** (not sequentially)

### 5. Multiple Pawn Display at Start/Home
- When multiple pawns occupy the same space (start circle or home star), spread them out in formations:
  - **4 pawns**: Square formation
  - **3 pawns**: Triangle (2 on top, 1 below from player's perspective, rotating around the board)
  - **2 pawns**: Line formation
  - **1 pawn**: Centered
- Formations rotate based on seat position (Red=0°, Blue=90°, Yellow=180°, Green=270°)
- Clicking any pawn in a start formation selects one pawn (order doesn't matter, one at a time)
- All pawns in formation at start should highlight when a legal move is available

### 6. Tile Highlighting
- Clickable/selectable tiles must have a visual highlight overlay on top of the board image
- Legal move destinations should glow/pulse to indicate interactivity
- Selected pawn destination should have stronger highlight

### 7. Interface Toggle
- Two interface modes accessible via buttons:
  - **"Basic Interface"**: Current CSS-based UI (existing implementation)
  - **"¡Lo Siento!"**: New image-based visual UI
- Toggle buttons visible during active game
- All game functionality remains identical between modes—only visuals change

### 8. Feature Parity
All existing UI features must work in both modes:
- Pawn selection and move selection
- Legal mover highlighting
- Destination highlighting
- Turn indicators
- Card display
- Game status, card history, seat information panels

---

## Available Assets (in `frontend/assets/`)

| Asset | File | Size |
|-------|------|------|
| Board | `board.png` | 140 KB |
| Red Pawn | `pawn-red.png` | 2.2 KB |
| Blue Pawn | `pawn-blue.png` | 2.2 KB |
| Yellow Pawn | `pawn-yellow.png` | 2.2 KB |
| Green Pawn | `pawn-green.png` | 2.2 KB |

---

## PNG vs SVG Analysis

### PNG Advantages
- **Smaller file size**: Total ~150 KB vs ~1.5 MB for SVGs
- **Faster initial load**: Less parsing overhead
- **Predictable rendering**: Raster images render identically across browsers
- **Animation-friendly**: Easier to transform (translate, rotate, scale) without recalculating vector paths
- **Hardware acceleration**: GPU-composited transforms work well with raster images

### SVG Advantages
- **Resolution independence**: Crisp at any zoom level / high-DPI displays
- **DOM manipulability**: Can style/animate individual paths if needed
- **Future flexibility**: Can be modified programmatically (e.g., change colors)

### Recommendation: **Use PNGs**

**Rationale:**
1. **Animation performance**: The arching motion, sliding, and spinning animations will involve frequent CSS transforms (translate3d, rotate). PNGs are simpler to composite and transform efficiently.
2. **File size**: The SVG pawns are ~250 KB *each*—this is unusually large (likely high path complexity from Figma export). Loading 4 pawns = 1 MB just for pawns. PNGs total ~9 KB.
3. **Fixed display size**: The board is 800×800 and pawns fit in 50×50. At these fixed dimensions, PNG quality is sufficient.
4. **Retina support**: If needed, export @2x versions (100×100 pawns, 1600×1600 board) for high-DPI displays.

**Alternative**: If SVG quality is strongly preferred, consider optimizing the SVGs with SVGO to reduce path complexity before use.

---

## Implementation Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Game Container                           │
├─────────────────────────────────────────────────────────────────┤
│  [Basic Interface] [Lo Siento]   ← Interface toggle buttons     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                  Board Container                        │   │
│   │                                                         │   │
│   │   (Basic Mode)          OR        (Lo Siento Mode)      │   │
│   │   ┌───────────────┐               ┌───────────────┐     │   │
│   │   │ CSS Grid      │               │ Canvas Layer  │     │   │
│   │   │ .track-grid   │               │ - Board image │     │   │
│   │   │ 16×16 cells   │               │ - Highlight   │     │   │
│   │   │ CSS pawns     │               │   overlays    │     │   │
│   │   └───────────────┘               │ - Animated    │     │   │
│   │                                   │   pawns       │     │   │
│   │                                   └───────────────┘     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Component Structure

#### 1. Interface Mode State
```javascript
let interfaceMode = 'basic'; // 'basic' | 'losiento'
```

#### 2. Board Renderer Abstraction
Create a renderer interface that both modes implement:

```javascript
const BoardRenderer = {
  basic: {
    render(gameState) { /* existing CSS grid logic */ },
    highlightTile(row, col) { /* CSS class toggle */ },
    movePawn(pawnId, from, to) { /* instant update */ }
  },
  losiento: {
    render(gameState) { /* canvas/DOM image rendering */ },
    highlightTile(row, col) { /* overlay div positioning */ },
    movePawn(pawnId, from, to, options) { /* animated transition */ }
  }
};
```

#### 3. Lo Siento Board Implementation

**Option A: CSS + DOM (Recommended for simplicity)**
```html
<div class="losiento-board-container">
  <!-- Background board image -->
  <img src="future_assets/lo siento board.png" class="board-bg" />
  
  <!-- Transparent overlay grid for click detection & highlights -->
  <div class="highlight-grid">
    <!-- Positioned divs for each tile, invisible unless highlighted -->
  </div>
  
  <!-- Pawn layer with absolutely positioned pawns -->
  <div class="pawn-layer">
    <img class="pawn pawn-red" data-pawn-id="..." />
    <!-- etc -->
  </div>
</div>
```

**Option B: HTML Canvas**
- Single canvas element
- Draw board image, highlights, and pawns programmatically
- Better for complex animations but harder to handle click events

**Recommendation**: Option A (DOM-based) for maintainability and easier event handling.

#### 4. Coordinate Mapping

The existing code maps track indices 0–59 to a 16×16 grid. For the new 800×800 board with 50×50 tiles:

```javascript
function tilePixelPosition(trackIndex) {
  const { row, col } = coordForTrackIndex(trackIndex);
  // Assuming board image has tiles starting at (0,0)
  // Each tile is 50px
  return {
    x: col * 50,
    y: row * 50
  };
}
```

*Note: The exact mapping may require adjustment based on how the Figma board image aligns tiles. May need offset constants if there's padding.*

#### 5. Animation System

**Arching Movement (CSS Keyframes)**
```css
@keyframes pawn-arch {
  0% {
    transform: translate(var(--start-x), var(--start-y));
  }
  50% {
    transform: translate(
      calc((var(--start-x) + var(--end-x)) / 2),
      calc((var(--start-y) + var(--end-y)) / 2 - 30px)  /* peak of arch */
    );
  }
  100% {
    transform: translate(var(--end-x), var(--end-y));
  }
}
```

**Slide Movement**
```css
@keyframes pawn-slide {
  from { transform: translate(var(--start-x), var(--start-y)); }
  to { transform: translate(var(--end-x), var(--end-y)); }
}
.pawn-sliding {
  animation: pawn-slide 0.15s linear;
}
```

**Knockout Spin**
```css
@keyframes pawn-knockout {
  0% {
    transform: translate(var(--start-x), var(--start-y)) rotate(0deg);
  }
  100% {
    transform: translate(var(--end-x), var(--end-y)) rotate(720deg);
  }
}
.pawn-knockout {
  animation: pawn-knockout 0.6s ease-in-out;
}
```

**JavaScript Animation Controller**
```javascript
async function animatePawnMove(pawnEl, from, to, type = 'arch') {
  const startPos = tilePixelPosition(from);
  const endPos = tilePixelPosition(to);
  
  pawnEl.style.setProperty('--start-x', `${startPos.x}px`);
  pawnEl.style.setProperty('--start-y', `${startPos.y}px`);
  pawnEl.style.setProperty('--end-x', `${endPos.x}px`);
  pawnEl.style.setProperty('--end-y', `${endPos.y}px`);
  
  pawnEl.classList.add(`pawn-${type}`);
  
  return new Promise(resolve => {
    pawnEl.addEventListener('animationend', () => {
      pawnEl.classList.remove(`pawn-${type}`);
      // Set final position
      pawnEl.style.transform = `translate(${endPos.x}px, ${endPos.y}px)`;
      resolve();
    }, { once: true });
  });
}
```

#### 6. Stacked Pawn Counter

```html
<div class="pawn-stack" style="--x: 100px; --y: 50px;">
  <img src="future_assets/red pawn.png" class="pawn-img" />
  <span class="pawn-count">3</span>
</div>
```

```css
.pawn-stack {
  position: absolute;
  transform: translate(var(--x), var(--y));
}
.pawn-count {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 14px;
  font-weight: 700;
  color: #000;
  text-shadow: 0 0 2px #fff;
}
```

#### 7. Highlight Overlays

```css
.tile-highlight {
  position: absolute;
  width: 50px;
  height: 50px;
  background: rgba(250, 204, 21, 0.4);
  border: 2px solid rgba(250, 204, 21, 0.8);
  border-radius: 4px;
  pointer-events: auto;
  cursor: pointer;
  animation: highlight-pulse 1s ease-in-out infinite;
}

@keyframes highlight-pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
```

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Move assets from `future_assets/` to `assets/` (or keep in place)
- [ ] Add interface toggle buttons to game UI
- [ ] Create `interfaceMode` state variable
- [ ] Create Lo Siento board container (hidden by default)

### Phase 2: Static Board Rendering
- [ ] Render board background image
- [ ] Map tile coordinates to pixel positions
- [ ] Render pawns at correct positions (no animation)
- [ ] Implement highlight overlays for legal moves

### Phase 3: Interactivity
- [ ] Click detection on highlight overlays
- [ ] Pawn selection in Lo Siento mode
- [ ] Wire up to existing game logic (same handlers as basic mode)

### Phase 4: Animations
- [ ] Implement arching movement animation
- [ ] Implement slide animation
- [ ] Implement knockout spin animation
- [ ] Handle multi-tile traversal (animate through each tile sequentially)

### Phase 5: Polish
- [ ] Stacked pawn counter display
- [ ] Smooth transitions between game states
- [ ] Performance optimization (preload images, use will-change)
- [ ] Test on mobile/tablet viewports

---

## Resolved Questions

1. **Board alignment**: Tiles start at pixel (0,0). Each tile is 50×50 with 1px black border.
2. **Tile clickable areas**: Entire 50×50 area is clickable.
3. **Animation timing**: ~150-200ms per tile for arch, faster for slides.
4. **Multi-hop animation**: Animate through each intermediate tile individually.
5. **Sound effects**: Future support planned:
   - Sound for moving pieces
   - Soundbite for "¡Lo Siento!"
   - Background music

---

## File Changes Summary

| File | Changes |
|------|---------|
| `frontend/app.js` | Add interface mode toggle, Lo Siento renderer, animation logic |
| `frontend/style.css` | Add Lo Siento mode styles, animation keyframes |
| `frontend/index.html` | Add toggle buttons, Lo Siento board container |
| `frontend/assets/` | (Optional) relocate images from `future_assets/` |

---

*Document created: November 2024*
*Last updated: November 2024*
