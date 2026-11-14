const actors = {
  policy: { coat: '#53798f', light: '#8dafbc', hair: '#3d3241', skin: '#f0be93' },
  supply: { coat: '#5d7753', light: '#a5b486', hair: '#704336', skin: '#dfaa7b' },
  company: { coat: '#a9654d', light: '#e29465', hair: '#432f38', skin: '#edb18a' },
  market: { coat: '#665578', light: '#9c86a6', hair: '#312d3a', skin: '#e9b58c' },
  chair: { coat: '#9a713f', light: '#d8ab65', hair: '#65434c', skin: '#ebbb8e' },
};

const positions = {
  desks: { policy: [22, 76], supply: [11, 83], company: [32, 91], market: [94, 65], chair: [62, 90] },
  meeting: { policy: [27, 72], supply: [33, 82], company: [43, 85], market: [58, 74], chair: [53, 84] },
  'side-meeting': { company: [71, 76], chair: [88, 77], policy: [88, 77] },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const stageTitles = {
  start: '准备会议',
  analysis: '核对证据',
  challenge: '提出异议',
  review: '复核证据',
  decision: '形成结论',
};

const spriteFrames = ['rest', 'blink', 'stride-left', 'stride-right', 'scan', 'write', 'check', 'speak', 'gesture'];

function drawFrame(ctx, id, palette, frameIndex) {
  const frame = spriteFrames[frameIndex];
  const edge = '#25212b';
  const shade = '#aa735b';
  const put = (color, x, y, w, h) => {
    ctx.fillStyle = color;
    ctx.fillRect(frameIndex * 18 + x, y, w, h);
  };
  const stride = frame.startsWith('stride');
  const offset = stride || frame === 'gesture' ? -1 : 0;
  const working = ['scan', 'write', 'check'].includes(frame);
  const speaking = frame === 'speak' || frame === 'gesture';
  const body = (color, x, y, w, h) => put(color, x, y + offset, w, h);

  put(edge, frame === 'stride-left' ? 3 : 5, frame === 'stride-right' ? 22 : 21, 4, 2);
  put(edge, frame === 'stride-right' ? 11 : 9, frame === 'stride-left' ? 22 : 21, 4, 2);
  put('#654b49', 5, 19, 8, 2);
  body(edge, 4, 12, 10, 8);
  body(edge, 2, 14, 14, 5);
  body(palette.coat, 4, 13, 10, 6);
  body(palette.light, 5, 13, 8, 2);
  body(palette.skin, 2, frame === 'stride-left' ? 17 : 16, 2, 2);
  body(palette.skin, 14, frame === 'stride-right' ? 17 : 16, 2, 2);
  body('#f9e4b9', 8, 13, 2, 4);
  body(edge, 5, 1, 8, 2);
  body(edge, 3, 2, 12, 10);
  body(palette.hair, 4, 2, 10, 5);
  body(palette.hair, 5, 1, 8, 3);
  body(palette.skin, 5, 5, 8, 6);
  body(palette.skin, 6, 11, 6, 2);
  body(shade, 7, 12, 4, 1);
  body('#3a2b35', 6, frame === 'blink' ? 8 : 7, 1, frame === 'blink' ? 1 : 2);
  body('#3a2b35', 11, frame === 'blink' ? 8 : 7, 1, frame === 'blink' ? 1 : 2);
  body(speaking ? '#673944' : shade, 8, 10, 2, frame === 'speak' ? 2 : 1);
  if (id === 'policy') {
    body('#694a49', 5, 7, 8, 1);
    body('#f8d8a9', 7, 8, 1, 1);
    body('#f8d8a9', 10, 8, 1, 1);
  }
  if (id === 'company') body(palette.hair, 12, 4, 2, 6);
  if (id === 'market') body(palette.light, 4, 3, 10, 2);
  if (id === 'chair') body('#e9cc93', 4, 4, 2, 2);

  if (frame === 'gesture') {
    body(edge, 14, 11, 3, 7);
    body(palette.coat, 14, 13, 2, 5);
    body(palette.skin, 14, 11, 2, 2);
  }
  if (working) {
    body(edge, 4, 13, 10, 7);
    body('#8a6e55', 5, 14, 8, 5);
    body('#e8ca8d', 6, 14, 6, 4);
    body('#7b6548', 7, 15, 4, 1);
    body('#6d8167', 7, 17, frame === 'scan' ? 2 : 4, 1);
    body(palette.skin, 4, 16, 2, 2);
    const pencil = frame === 'scan' ? 12 : frame === 'write' ? 9 : 10;
    body('#533e40', pencil, 15, 1, 3);
    body(palette.skin, pencil + 1, 15, 2, 2);
  }
}

function sprite(id, palette) {
  const canvas = document.createElement('canvas');
  canvas.width = 18 * spriteFrames.length;
  canvas.height = 24;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  for (const [frameIndex] of spriteFrames.entries()) drawFrame(ctx, id, palette, frameIndex);
  return canvas.toDataURL();
}

export function createRoomScene({ layer, speaker, speakerName, speakerText, speakerKind, status, onAgent, onActivity, onAnnouncement }) {
  const figures = new Map();
  const runs = new Map();
  const seen = new Set();
  const queue = [];
  let playing = false;
  let generation = 0;
  let lastLiveRun = 0;
  let resizeFrame = 0;
  let anchor = null;
  let sideMeeting = false;
  let roomOwner = null;

  for (const [index, [id, palette]] of Object.entries(actors).entries()) {
    const actor = document.createElement('button');
    const graphic = document.createElement('span');
    graphic.className = 'actor-graphic';
    graphic.style.backgroundImage = `url("${sprite(id, palette)}")`;
    const taskBubble = document.createElement('span');
    taskBubble.className = 'actor-task-bubble';
    taskBubble.dataset.agent = id;
    taskBubble.hidden = true;
    taskBubble.setAttribute('aria-hidden', 'true');
    actor.className = 'world-actor';
    actor.style.setProperty('--idle-delay', `${-index * 730}ms`);
    actor.dataset.agent = id;
    actor.type = 'button';
    actor.hidden = true;
    actor.append(graphic, taskBubble);
    actor.addEventListener('click', () => onAgent(id));
    layer.append(actor);
    figures.set(id, {
      actor, taskBubble, name: id, room: 'desks', position: positions.desks[id],
      tasks: new Map(), badgeTimer: null, badgeUntil: 0,
    });
    position(id, 'desks');
  }

  function position(id, room) {
    const figure = figures.get(id);
    const next = positions[room]?.[id];
    if (!figure || !next) return false;
    const moved = figure.room !== room;
    figure.room = room;
    figure.position = next;
    figure.actor.style.left = `${next[0]}%`;
    figure.actor.style.top = `${next[1]}%`;
    figure.actor.style.zIndex = String(Math.floor(next[1]));
    figure.actor.classList.toggle('bubble-to-left', next[0] >= 82);
    figure.actor.classList.toggle('bubble-to-right', next[0] <= 16);
    return moved;
  }

  function alignSpeech() {
    const figure = figures.get(anchor?.agentId);
    if (!figure || anchor.element.hidden) return;
    const room = layer.parentElement.parentElement.getBoundingClientRect();
    const feet = figure.actor.getBoundingClientRect();
    const bubble = anchor.element;
    const center = feet.left - room.left + feet.width / 2;
    const half = bubble.offsetWidth / 2;
    const constrained = Math.max(half + 9, Math.min(room.width - half - 9, center));
    bubble.style.setProperty('--speech-left', `${constrained}px`);
    const tail = Math.max(9, Math.min(2 * half - 9, half + center - constrained));
    bubble.style.setProperty('--speech-tail', `${tail}px`);
    bubble.style.setProperty('--speech-bottom', `${Math.max(12, room.bottom - feet.top + 10)}px`);
  }

  function scheduleAlignment() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(alignSpeech);
  }

  new ResizeObserver(scheduleAlignment).observe(layer.parentElement.parentElement);

  function clearBubble() {
    speaker.hidden = true;
    if (anchor?.element === speaker) anchor = null;
    for (const { actor } of figures.values()) actor.classList.remove('speaking');
  }

  function clearTaskBubble(figure) {
    clearTimeout(figure.badgeTimer);
    figure.badgeTimer = null;
    figure.badgeUntil = 0;
    figure.taskBubble.hidden = true;
    delete figure.taskBubble.dataset.taskId;
    delete figure.taskBubble.dataset.runId;
    delete figure.taskBubble.dataset.taskStatus;
  }

  function clearTasks(runId) {
    for (const figure of figures.values()) {
      for (const [key, task] of figure.tasks) {
        if (!runId || task.runId === runId) figure.tasks.delete(key);
      }
      figure.actor.classList.toggle('working', figure.tasks.size > 0);
      if (!figure.tasks.size) delete figure.actor.dataset.taskState;
      if (!runId || figure.taskBubble.dataset.runId === runId) clearTaskBubble(figure);
    }
  }

  function updateTask(event) {
    const figure = figures.get(event.agentId);
    const { status, taskId, runId, presentation } = event;
    if (roomOwner !== runId || !figure || !taskId || !['start', 'complete', 'failed'].includes(status)) return;
    const key = `${runId}:${taskId}`;
    if (status === 'start') figure.tasks.set(key, event);
    else figure.tasks.delete(key);
    figure.actor.classList.toggle('working', figure.tasks.size > 0);
    figure.actor.dataset.taskState = status;
    if (status === 'start' && figure.badgeUntil > Date.now()) return;
    const bubble = figure.taskBubble;
    clearTaskBubble(figure);
    bubble.dataset.taskId = taskId;
    bubble.dataset.runId = runId;
    bubble.dataset.taskStatus = status;
    const title = event.label || '研究任务';
    const result = status === 'complete' && presentation !== 'report' ? event.shortMessage : '';
    bubble.textContent = status === 'failed' ? `${title}未完成` : result || `${status === 'complete' ? '已完成 · ' : ''}${title}`;
    bubble.title = status === 'complete' && presentation !== 'report' ? event.message || bubble.textContent : bubble.textContent;
    bubble.hidden = false;
    if (status !== 'start') {
      const duration = status === 'complete' ? 1700 : 1600;
      figure.badgeUntil = Date.now() + duration;
      const epoch = generation;
      figure.badgeTimer = setTimeout(() => {
        if (generation !== epoch || roomOwner !== runId || bubble.dataset.runId !== runId) return;
        const next = [...figure.tasks.values()].at(-1);
        if (next) updateTask(next);
        else clearTaskBubble(figure);
      }, duration);
    }
  }

  function label(text = '', details = '') {
    status.hidden = !text;
    status.textContent = text;
    status.title = details;
  }

  async function walk(ids, room) {
    const moved = [];
    for (const id of ids) {
      const figure = figures.get(id);
      const next = positions[room]?.[id];
      if (!figure || !next || figure.room === room) continue;
      figure.actor.classList.toggle('facing-left', next[0] < figure.position[0]);
      figure.actor.classList.add('walking');
      if (position(id, room)) moved.push(figure);
    }
    if (moved.length && !reduceMotion()) await wait(640);
    for (const { actor } of moved) actor.classList.remove('walking');
    scheduleAlignment();
  }

  async function speak(row, kind = 'trace') {
    const figure = figures.get(row.agentId);
    if (!figure || !row.message) return;
    clearBubble();
    speakerName.textContent = figure.name;
    speakerText.textContent = row.message;
    if (speakerKind) speakerKind.textContent = kind === 'task' ? '任务完成' : '现场发言';
    speaker.dataset.kind = kind;
    speaker.dataset.agent = row.agentId;
    if (row.taskId) speaker.dataset.taskId = row.taskId;
    else delete speaker.dataset.taskId;
    speakerText.scrollTop = 0;
    speaker.hidden = false;
    anchor = { element: speaker, agentId: row.agentId };
    figure.actor.classList.add('speaking');
    alignSpeech();
    const duration = reduceMotion() ? 1250 : Math.min(2800, 1200 + row.message.length * 24);
    await wait(duration);
    clearBubble();
  }

  async function show(event) {
    if (event.type === 'run-start') {
      roomOwner = event.runId;
      clearBubble();
      label(event.scope === 'monitor' ? '监测触发的临时会议' : '召开回放会议');
      if (event.headline) onAnnouncement(event.headline);
      return;
    }
    if (event.type === 'movement') {
      clearBubble();
      await walk(event.agentIds ?? [], event.room);
      return;
    }
    if (event.type === 'side-meeting') {
      sideMeeting = event.status === 'start';
      layer.classList.toggle('side-meeting-active', sideMeeting);
      label(sideMeeting ? '小范围复核' : '返回圆桌', sideMeeting ? event.reason : '');
      return;
    }
    if (event.type === 'stage') {
      if (!sideMeeting) label(stageTitles[event.stage] ?? '');
      return;
    }
    if (event.type === 'trace' && event.row?.kind === 'message') {
      await speak(event.row);
    } else if (event.type === 'task') {
      if (!event.displayed) updateTask(event);
      if (event.status === 'complete' && event.presentation === 'report' && event.message) await speak(event, 'task');
    }
  }

  async function play() {
    if (playing) return;
    playing = true;
    const epoch = generation;
    onActivity(true);
    try {
      while (epoch === generation && queue.length) {
        const run = queue[0];
        while (epoch === generation && run.events.length) await show(run.events.shift());
        if (epoch !== generation || !run.ended) break;
        clearBubble();
        clearTasks(run.id);
        roomOwner = null;
        layer.classList.remove('side-meeting-active');
        sideMeeting = false;
        label(run.failed ? '会议中止' : '会议已记录');
        queue.shift();
        runs.delete(run.id);
        await walk([...figures.keys()], 'desks');
      }
    } finally {
      playing = false;
      if (queue.length === 0) {
        label();
        onActivity(false);
      } else if (queue[0].events.length || queue[0].ended) {
        void play();
      }
    }
  }

  function push(event) {
    if (!event?.runId) return;
    if (Number.isInteger(event.seq)) {
      if (seen.has(event.seq)) return;
      seen.add(event.seq);
      if (seen.size > 500) seen.delete(seen.values().next().value);
    }
    let run = runs.get(event.runId);
    if (event.type === 'run-start') {
      if (run) return;
      run = { id: event.runId, events: [event], reported: new Map(), ended: false, failed: false };
      runs.set(event.runId, run);
      queue.push(run);
      if (event.scope === 'replay') lastLiveRun = Date.now();
    } else if (run) {
      if (event.type === 'run-complete' || event.type === 'run-error') {
        run.ended = true;
        run.failed = event.type === 'run-error';
      } else if (event.type === 'task') {
        const displayed = roomOwner === run.id;
        if (displayed) updateTask(event);
        if (event.status === 'complete' && event.presentation === 'report' && event.message) {
          run.reported.set(event.taskId, event.message);
        }
        if (!displayed || (event.status === 'complete' && event.presentation === 'report' && event.message)) {
          run.events.push({ ...event, displayed });
        }
      } else if (event.type !== 'trace' ||
        (event.row?.kind === 'message' && run.reported.get(event.row.taskId) !== event.row.message)) {
        run.events.push(event);
      }
    }
    if (run) void play();
  }

  function setAgents(agents) {
    for (const agent of agents) {
      const figure = figures.get(agent.id);
      if (!figure) continue;
      figure.name = agent.name;
      figure.actor.setAttribute('aria-label', `查看${agent.name}的研究员档案`);
      figure.actor.title = `${agent.name} · ${agent.role}`;
      figure.actor.hidden = false;
    }
  }

  function placeReplay(element, entry) {
    if (queue.length) return;
    layer.classList.add('replay-positions');
    const side = ['challenge', 'review'].includes(entry.stage);
    for (const agentId of figures.keys()) {
      position(agentId, side && ['chair', 'company'].includes(agentId) ? 'side-meeting' : 'meeting');
    }
    anchor = { element, agentId: entry.agentId };
    alignSpeech();
    layer.classList.remove('replay-positions');
  }

  function endReplay(element) {
    if (anchor?.element === element) anchor = null;
    if (!queue.length) void walk([...figures.keys()], 'desks');
  }

  function resetStream() {
    generation += 1;
    queue.length = 0;
    runs.clear();
    seen.clear();
    lastLiveRun = 0;
    roomOwner = null;
    clearBubble();
    clearTasks();
    sideMeeting = false;
    layer.classList.remove('side-meeting-active');
    label();
    for (const id of figures.keys()) position(id, 'desks');
    onActivity(false);
  }

  return { push, resetStream, setAgents, placeReplay, endReplay, recentManual: (startedAt) => lastLiveRun >= startedAt, active: () => queue.length > 0 };
}
