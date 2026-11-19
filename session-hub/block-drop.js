(() => {
  const ui = Object.fromEntries([
    'open', 'board', 'next', 'held', 'score', 'lines', 'level', 'status', 'pause', 'restart'
  ].map(name => [name, document.getElementById('block-drop-' + name)]));
  const dialog = document.getElementById('block-drop');
  const board = ui.board.getContext('2d');
  const next = ui.next.getContext('2d');
  const held = ui.held.getContext('2d');
  const columns = 10;
  const rows = 20;
  const cellSize = 24;
  const lockDelay = 450;
  const maxLockResets = 12;
  const pieces = [
    {color: '#86dccc', shape: ['0000', '1111', '0000', '0000']},
    {color: '#f4bd86', shape: ['11', '11']},
    {color: '#b6a3ff', shape: ['010', '111', '000']},
    {color: '#aada8d', shape: ['011', '110', '000']},
    {color: '#ee919d', shape: ['110', '011', '000']},
    {color: '#91afff', shape: ['100', '111', '000']},
    {color: '#f1db7d', shape: ['001', '111', '000']}
  ];
  let game;
  let frame;

  function cells(shape) {
    return shape.flatMap((row, y) => Array.from(row).flatMap((value, x) =>
      value === '1' ? [[x, y]] : []));
  }

  function refill() {
    if (game.queue.length) return;
    const bag = [...pieces];
    for (let i = bag.length - 1; i > 0; i--) {
      const swap = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[swap]] = [bag[swap], bag[i]];
    }
    game.queue = bag;
  }

  function fits(piece, dx = 0, dy = 0) {
    return piece.cells.every(([x, y]) => {
      const col = piece.x + x + dx;
      const row = piece.y + y + dy;
      return col >= 0 && col < columns && row < rows && (row < 0 || !game.grid[row][col]);
    });
  }

  function gravity() {
    return Math.max(75, 850 * 0.82 ** (game.level - 1));
  }

  function spawn(now, type = game.queue.shift()) {
    refill();
    const shape = type.shape;
    const occupied = cells(shape);
    game.active = {
      type, shape, cells: occupied,
      x: Math.floor((columns - shape.length) / 2),
      y: -occupied[0][1]
    };
    game.fallAt = now + gravity();
    game.lockAt = null;
    game.lockResets = 0;
    if (fits(game.active)) updateLock(now);
    else finish();
  }

  function updateLock(now, movedOnFloor = false) {
    if (fits(game.active, 0, 1)) {
      game.lockAt = null;
    } else if (game.lockAt === null) {
      game.lockAt = now + lockDelay;
    } else if (movedOnFloor && game.lockResets < maxLockResets) {
      game.lockAt = now + lockDelay;
      game.lockResets++;
    }
  }

  function place(now) {
    const piece = game.active;
    if (piece.cells.some(([, y]) => y + piece.y < 0)) {
      finish();
      return;
    }
    for (const [x, y] of piece.cells) game.grid[y + piece.y][x + piece.x] = piece.type.color;
    const remaining = game.grid.filter(row => row.includes(null));
    const cleared = rows - remaining.length;
    game.grid = Array.from({length: cleared}, () => Array(columns).fill(null)).concat(remaining);
    game.score += [0, 100, 300, 500, 800][cleared] * game.level;
    game.lines += cleared;
    game.level = 1 + Math.floor(game.lines / 10);
    game.canHold = true;
    spawn(now);
  }

  function start() {
    cancelAnimationFrame(frame);
    game = {
      grid: Array.from({length: rows}, () => Array(columns).fill(null)),
      queue: [], held: null, canHold: true, score: 0, lines: 0, level: 1, state: 'playing'
    };
    refill();
    spawn(performance.now());
    syncControls();
    draw();
    frame = requestAnimationFrame(tick);
  }

  function finish() {
    game.state = 'over';
    game.active = null;
    cancelAnimationFrame(frame);
    syncControls();
  }

  function pause() {
    if (game?.state !== 'playing') return;
    game.state = 'paused';
    game.pausedAt = performance.now();
    cancelAnimationFrame(frame);
    syncControls();
  }

  function togglePause() {
    if (game.state === 'playing') {
      pause();
    } else if (game.state === 'paused') {
      const elapsed = performance.now() - game.pausedAt;
      game.fallAt += elapsed;
      if (game.lockAt !== null) game.lockAt += elapsed;
      game.state = 'playing';
      syncControls();
      frame = requestAnimationFrame(tick);
    }
  }

  function syncControls() {
    ui.pause.disabled = game.state === 'over';
    ui.pause.textContent = game.state === 'paused' ? 'Resume' : 'Pause';
    ui.status.textContent = {playing: '', paused: 'Paused', over: 'Game over'}[game.state];
  }

  function step(now, softDrop = false) {
    if (fits(game.active, 0, 1)) {
      game.active.y++;
      if (softDrop) game.score++;
    }
    game.fallAt = now + gravity();
    updateLock(now);
  }

  function tick(now) {
    if (!dialog.open || game.state !== 'playing') return;
    if (game.lockAt !== null && now >= game.lockAt) {
      place(now);
      draw();
    } else if (now >= game.fallAt) {
      step(now);
      draw();
    }
    if (game.state === 'playing') frame = requestAnimationFrame(tick);
  }

  function slide(dx, now) {
    if (!fits(game.active, dx)) return;
    game.active.x += dx;
    updateLock(now, true);
  }

  function rotate(now) {
    const piece = game.active;
    if (piece.shape.length === 2) return;
    const size = piece.shape.length;
    const shape = piece.shape.map((_, y) =>
      piece.shape.map((_, x) => piece.shape[size - 1 - x][y]).join(''));
    const rotated = {...piece, shape, cells: cells(shape)};
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1], [0, -2]]) {
      if (!fits(rotated, dx, dy)) continue;
      rotated.x += dx;
      rotated.y += dy;
      game.active = rotated;
      updateLock(now, true);
      break;
    }
  }

  function dropDistance() {
    let distance = 0;
    while (fits(game.active, 0, distance + 1)) distance++;
    return distance;
  }

  function hardDrop(now) {
    const distance = dropDistance();
    game.active.y += distance;
    game.score += distance * 2;
    place(now);
  }

  function hold(now) {
    if (!game.canHold) return;
    const previous = game.held;
    game.held = game.active.type;
    game.canHold = false;
    spawn(now, previous || undefined);
  }

  function paint(context, x, y, size, color, outline = false) {
    if (outline) {
      context.strokeStyle = color;
      context.strokeRect(x + 3.5, y + 3.5, size - 7, size - 7);
      return;
    }
    context.fillStyle = color;
    context.fillRect(x + 1, y + 1, size - 2, size - 2);
    context.fillStyle = '#ffffff40';
    context.fillRect(x + 2, y + 2, size - 4, 2);
  }

  function drawPreview(context, type) {
    const {width, height} = context.canvas;
    context.clearRect(0, 0, width, height);
    if (!type) return;
    const points = cells(type.shape);
    const size = 16;
    const top = points[0][1];
    const left = Math.min(...points.map(([x]) => x));
    const wide = Math.max(...points.map(([x]) => x)) - left + 1;
    const high = points.at(-1)[1] - top + 1;
    for (const [x, y] of points) {
      paint(context, (width - wide * size) / 2 + (x - left) * size,
        (height - high * size) / 2 + (y - top) * size, size, type.color);
    }
  }

  function draw() {
    board.clearRect(0, 0, ui.board.width, ui.board.height);
    game.grid.forEach((row, y) => row.forEach((color, x) => {
      if (color) paint(board, x * cellSize, y * cellSize, cellSize, color);
      else {
        board.fillStyle = '#232236';
        board.fillRect(x * cellSize + 1, y * cellSize + 1, cellSize - 2, cellSize - 2);
      }
    }));
    const piece = game.active;
    if (piece) {
      const distance = dropDistance();
      for (const [x, y] of piece.cells) {
        paint(board, (piece.x + x) * cellSize, (piece.y + y + distance) * cellSize, cellSize, piece.type.color, true);
      }
      for (const [x, y] of piece.cells) {
        paint(board, (piece.x + x) * cellSize, (piece.y + y) * cellSize, cellSize, piece.type.color);
      }
    }
    ui.score.textContent = game.score;
    ui.lines.textContent = game.lines;
    ui.level.textContent = game.level;
    drawPreview(next, game.queue[0]);
    drawPreview(held, game.held);
  }

  const moves = new Map([
    ['ArrowLeft', now => slide(-1, now)],
    ['ArrowRight', now => slide(1, now)],
    ['ArrowUp', rotate],
    ['ArrowDown', now => step(now, true)],
    [' ', hardDrop],
    ['c', hold]
  ]);
  dialog.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    // Space keeps its native activation behavior on the dialog buttons.
    if (key === ' ' && event.target !== ui.board) return;
    const action = moves.get(event.key) || moves.get(key);
    if (key !== 'p' && !action) return;
    event.preventDefault();
    if (event.repeat && ['arrowup', ' ', 'c', 'p'].includes(key)) return;
    if (key === 'p') togglePause();
    else if (game.state === 'playing') {
      action(performance.now());
      draw();
    }
  });

  ui.open.addEventListener('click', () => {
    dialog.showModal();
    if (!game) start();
  });
  dialog.addEventListener('close', pause);
  ui.pause.addEventListener('click', () => {
    togglePause();
    ui.board.focus();
  });
  ui.restart.addEventListener('click', () => {
    start();
    ui.board.focus();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
})();
