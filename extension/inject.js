// Meet Mixer: runs inside the Meet page itself (MAIN world), before Meet's own code,
// so it sees every call connection and every audio element Meet creates.
//
// Meet sends only a few audio streams (the loudest speakers), and each stream switches
// between people. So the volume is set per stream, many times a second, to the volume
// of whoever is on that stream right now.
(() => {
  if (window.__meetMixer) return;

  // Shown in the panel title and in Copy details, to see which copy is running.
  // Raise it with every change sent out, together with "version" in manifest.json.
  const VERSION = 20;
  const STORE_KEY = 'meetMixer.v1';
  const MAX_PERCENT = 300;
  const TICK_MS = 20;
  const TALKING_MS = 400;   // a voice counts as talking this long after its last sound
  const SPEECH_BYTES = 40;  // an audio packet bigger than this is speech (Meet's quiet packets are ~26 bytes)
  // How long Meet's own decoder holds audio before it plays, until measured per stream
  // (real calls: 280–440 ms; starting too low switches volumes too early at first).
  const DECODE_DELAY_MS = 300;
  const SWITCH_GUARD_MS = 150; // around a speaker change, the lower of both volumes plays this long
  const LOUD_RMS = 0.01;
  const LINK_SCORE = 25;    // ticks of agreement before a decoded stream counts as linked to a slot

  const peers = new Set();
  const streams = [];       // one per remote audio track Meet plays
  const voices = new Map(); // source id (CSRC, or SSRC when there is none) -> voice
  let voiceCount = 0;       // numbers voices "Voice 1, 2…" (never reused when one is removed)
  let ctx = null;
  let sinkId = '';
  let ui = null;
  const saved = loadSaved();

  function loadSaved() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.nameVolumes) return { pinned: [], ...s };
    } catch (e) {}
    return { nameVolumes: {}, pinned: [], open: false };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch (e) {}
  }

  // 1. Remember every call connection, so we can ask who is on each stream.
  // Pages can also build connections from a hidden inner frame's window,
  // so every same-origin frame window gets the same wrapper on first access.
  const hookedFrames = [];
  // Counts for the panel's "Seen" line.
  const seen = { srcObjects: 0, webAudio: 0, unmatched: 0 };
  // For "Copy details": everything that could sit between the call and the speakers.
  const details = { webAudioTracks: [], encodedStreams: 0, transforms: 0, generators: 0, processors: 0, worklets: [], workers: 0 };
  const cloneOf = new WeakMap(); // copied track -> the track it was copied from
  // Meet decodes the voices itself in this audio worklet: one output per slot, each
  // going to the speakers and (as a copy) to Meet's speaking analyzer.
  const DECODER = 'neteq-processor';
  const decoderOutputOf = new WeakMap(); // analyzer copy track -> { node, output }
  function playGain(node, out) {
    if (!node.__mmPlay) node.__mmPlay = [];
    if (!node.__mmPlay[out]) {
      const g = node.context.createGain();
      g.__mmOurs = true;
      node.__mmPlay[out] = g;
    }
    return node.__mmPlay[out];
  }
  // How the page wires its Web Audio, to find the path that reaches the speakers.
  const graph = { edges: new Map(), worklets: [], contexts: [] };
  const nodeIds = new WeakMap();
  let graphNodeCount = 1;
  function nodeName(n) {
    if (!n || !n.constructor) return String(n);
    const type = n.constructor.name;
    if (type === 'AudioParam') return 'AudioParam';
    if (!nodeIds.has(n)) nodeIds.set(n, graphNodeCount++);
    let c = graph.contexts.indexOf(n.context);
    if (c < 0 && n.context) {
      graph.contexts.push(n.context);
      c = graph.contexts.length - 1;
    }
    const ours = n.__mmOurs ? ' (ours)' : '';
    const proc = n.__mmProcessor ? `(${n.__mmProcessor})` : '';
    return `ctx${c}:${type}${proc}#${nodeIds.get(n)}${ours}`;
  }
  function hookConnections(w) {
    try {
      if (w.__mmHooked || !w.RTCPeerConnection) return;
      w.__mmHooked = true;
      const NativePC = w.RTCPeerConnection;
      class TrackedPC extends NativePC {
        constructor(...args) {
          super(...args);
          peers.add(this);
        }
      }
      w.RTCPeerConnection = TrackedPC;
      if (w.webkitRTCPeerConnection) w.webkitRTCPeerConnection = TrackedPC;
      if (w !== window) {
        hookedFrames.push(w);
        hookMediaElements(w);
        hookWebAudio(w);
      }
      hookCopiesAndDecoders(w);
    } catch (e) {} // a frame from another site: not ours to touch
  }

  // Remember copied tracks (so a copy still finds its call), and count the ways
  // a page can decode or reroute call audio itself.
  function hookCopiesAndDecoders(w) {
    const trackClone = w.MediaStreamTrack.prototype.clone;
    w.MediaStreamTrack.prototype.clone = function () {
      const copy = trackClone.call(this);
      cloneOf.set(copy, this);
      return copy;
    };
    const streamClone = w.MediaStream.prototype.clone;
    w.MediaStream.prototype.clone = function () {
      const copy = streamClone.call(this);
      const from = this.getTracks();
      copy.getTracks().forEach((t, i) => { if (from[i]) cloneOf.set(t, from[i]); });
      return copy;
    };
    const receiverProto = w.RTCRtpReceiver && w.RTCRtpReceiver.prototype;
    if (receiverProto && receiverProto.createEncodedStreams) {
      const native = receiverProto.createEncodedStreams;
      receiverProto.createEncodedStreams = function () {
        details.encodedStreams++;
        return tapEncoded(this, native.call(this));
      };
    }
    const transformDesc = receiverProto && Object.getOwnPropertyDescriptor(receiverProto, 'transform');
    if (transformDesc && transformDesc.set) {
      Object.defineProperty(receiverProto, 'transform', {
        configurable: true,
        enumerable: transformDesc.enumerable,
        get() { return transformDesc.get.call(this); },
        set(v) { if (v) details.transforms++; transformDesc.set.call(this, v); },
      });
    }
    for (const [name, key] of [['MediaStreamTrackGenerator', 'generators'], ['MediaStreamTrackProcessor', 'processors']]) {
      const Native = w[name];
      if (!Native) continue;
      w[name] = class extends Native {
        constructor(...args) { super(...args); details[key]++; }
      };
    }
    const nativeConnect = w.AudioNode.prototype.connect;
    const nativeDisconnect = w.AudioNode.prototype.disconnect;
    w.AudioNode.prototype.connect = function (dest, output, input) {
      if (graph.edges.size < 400) {
        const edge = `${nodeName(this)} -> ${nodeName(dest)}${output ? ` out${output}` : ''}${input ? ` in${input}` : ''}`;
        graph.edges.set(edge, (graph.edges.get(edge) || 0) + 1);
      }
      if (this.__mmProcessor === DECODER && dest && dest.constructor) {
        const out = output || 0;
        if (dest.constructor.name === 'MediaStreamAudioDestinationNode') {
          // The copy Meet sends to its speaking analyzer: tells us which output a decoded stream is.
          const t = dest.stream.getAudioTracks()[0];
          if (t) decoderOutputOf.set(t, { node: this, output: out });
        } else if (dest.constructor.name !== 'AudioParam') {
          // The way to the speakers: our gain goes between the decoder output and Meet's next node.
          const g = playGain(this, out);
          nativeConnect.call(this, g, out);
          // And a meter on the same output: timing measured here matches what you hear
          // (the analyzer copy goes through a second context and runs later).
          if (!g.__mmMeter) {
            g.__mmMeter = this.context.createAnalyser();
            g.__mmMeter.fftSize = 512;
            g.__mmMeter.__mmOurs = true;
          }
          nativeConnect.call(this, g.__mmMeter, out);
          return nativeConnect.call(g, dest, 0, input || 0);
        }
      }
      return nativeConnect.apply(this, arguments);
    };
    w.AudioNode.prototype.disconnect = function (...args) {
      if (!this.__mmPlay || !args.length) return nativeDisconnect.apply(this, args);
      // Meet disconnecting its decoder from a node that now hangs behind our gain.
      const [dest, output] = args;
      let done = false;
      try { nativeDisconnect.apply(this, args); done = true; } catch (e) {}
      if (dest && typeof dest === 'object') {
        this.__mmPlay.forEach((g, i) => {
          if (!g || (output != null && output !== i)) return;
          try { nativeDisconnect.call(g, dest); done = true; } catch (e) {}
        });
      }
      if (!done) nativeDisconnect.apply(this, args); // throws as it would have without us
    };
    const NativeWorkletNode = w.AudioWorkletNode;
    if (NativeWorkletNode) {
      w.AudioWorkletNode = class extends NativeWorkletNode {
        constructor(c, name, options) {
          super(c, name, options);
          this.__mmProcessor = name;
          graph.worklets.push({
            name,
            inputs: options && options.numberOfInputs,
            outputs: options && options.numberOfOutputs,
            channels: options && options.outputChannelCount,
          });
        }
      };
    }
    if (w.AudioWorklet) {
      const addModule = w.AudioWorklet.prototype.addModule;
      w.AudioWorklet.prototype.addModule = function (url, ...rest) {
        details.worklets.push(String(url).slice(0, 120));
        return addModule.call(this, url, ...rest);
      };
    }
    const NativeWorker = w.Worker;
    if (NativeWorker) {
      w.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); details.workers++; }
      };
    }
  }
  hookConnections(window);

  // Meet takes the call's audio out before Chrome decodes it (encoded streams) and
  // decodes it itself. Each packet still names its speaker, so we read that on the way.
  // One slot per receiver: Meet's few voice streams that switch between people.
  const slots = [];
  function tapEncoded(receiver, pair) {
    if (!receiver.track || receiver.track.kind !== 'audio') return pair;
    const slot = { receiver, number: slots.length + 1, recent: [], frames: 0, bytes: 0 };
    slots.push(slot);
    const tap = new TransformStream({
      transform(frame, controller) {
        try {
          const md = frame.getMetadata();
          const id = md.contributingSources && md.contributingSources.length ? md.contributingSources[0] : md.synchronizationSource;
          const bytes = frame.data.byteLength;
          slot.frames++;
          slot.bytes = bytes;
          slot.ssrc = md.synchronizationSource;
          slot.recent.push({ at: performance.now(), id, speech: bytes > SPEECH_BYTES });
          // About 1.5 s of packets: enough for the longest decoder delay we try (500 ms).
          if (slot.recent.length > 150) slot.recent.splice(0, slot.recent.length - 150);
        } catch (e) {}
        controller.enqueue(frame);
      },
    });
    return { readable: pair.readable.pipeThrough(tap), writable: pair.writable };
  }

  // Who was on a slot when the sound that plays now arrived (Meet's decoder holds it a moment).
  function slotPacket(slot, now, delay = DECODE_DELAY_MS) {
    for (let i = slot.recent.length - 1; i >= 0; i--) {
      const p = slot.recent[i];
      if (p.at <= now - delay) return now - p.at < delay + 100 ? p : null;
    }
    return null;
  }

  const contentWindowDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    enumerable: contentWindowDesc.enumerable,
    get() {
      const w = contentWindowDesc.get.call(this);
      if (w) hookConnections(w);
      return w;
    },
  });

  function findReceiver(track) {
    for (let t = track; t; t = cloneOf.get(t)) {
      for (const pc of peers) {
        for (const r of pc.getReceivers()) if (r.track === t) return r;
      }
    }
    return null;
  }

  // 2. Take over every remote audio track Meet plays through a media element.
  const mutedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
  function hookMediaElements(w) {
    const proto = w.HTMLMediaElement.prototype;
    const srcObjectDesc = Object.getOwnPropertyDescriptor(proto, 'srcObject');
    Object.defineProperty(proto, 'srcObject', {
      configurable: true,
      enumerable: srcObjectDesc.enumerable,
      get() { return srcObjectDesc.get.call(this); },
      set(value) {
        srcObjectDesc.set.call(this, value);
        if (value) seen.srcObjects++;
        // Not instanceof: a stream from an inner frame has that frame's MediaStream.
        if (value && typeof value.getAudioTracks === 'function') watchElement(this, value);
      },
    });

    // Meet's speaker choice goes to its elements; send it to our audio too.
    const nativeSetSinkId = proto.setSinkId;
    if (nativeSetSinkId) {
      proto.setSinkId = function (id) {
        sinkId = id;
        if (ctx && ctx.setSinkId) ctx.setSinkId(id).catch(() => {});
        return nativeSetSinkId.call(this, id);
      };
    }
  }
  hookMediaElements(window);

  // 3. Or take over a remote audio track Meet feeds into its own Web Audio:
  // a gain goes between Meet's source node and whatever Meet connects it to.
  function hookWebAudio(w) {
    const proto = w.AudioContext && w.AudioContext.prototype;
    if (!proto) return;
    for (const name of ['createMediaStreamSource', 'createMediaStreamTrackSource']) {
      const native = proto[name];
      if (!native) continue;
      proto[name] = function (arg) {
        const node = native.call(this, arg);
        if (this === ctx) return node; // our own
        seen.webAudio++;
        const track = name === 'createMediaStreamSource' ? arg.getAudioTracks()[0] : arg;
        if (track) details.webAudioTracks.push(track);
        if (track) adoptWebAudio(this, node, track);
        return node;
      };
    }
  }
  hookWebAudio(window);

  function adoptWebAudio(c, node, track) {
    if (track.kind !== 'audio' || streams.some((s) => s.track === track)) return;
    const receiver = findReceiver(track);
    // Meet's own decoded voices come back as tracks of Web Audio destination nodes:
    // those are linked to their slot by listening (see tickListened).
    const decoded = !receiver && track.label === 'MediaStreamAudioDestinationNode';
    if (!receiver && !decoded) { seen.unmatched++; return; }
    const gain = c.createGain();
    gain.__mmOurs = true;
    node.connect(gain);
    let meter = null;
    if (decoded) {
      meter = c.createAnalyser();
      meter.__mmOurs = true;
      meter.fftSize = 512;
      node.connect(meter);
    }
    node.connect = (...args) => gain.connect(...args);
    node.disconnect = (...args) => gain.disconnect(...args);
    const s = {
      el: null, ctx: c, track, receiver, source: node, gain, number: nextStreamNumber(), lastStamp: 0, voice: null, target: 1,
      meter, buf: meter ? new Float32Array(meter.fftSize) : null, scores: new Map(), slot: null, delay: DECODE_DELAY_MS,
    };
    streams.push(s);
    track.addEventListener('ended', () => dropStream(s));
    renderStatus();
  }

  function watchElement(el, stream) {
    for (const t of stream.getAudioTracks()) adoptTrack(el, t);
    if (!stream.__mmWatched) {
      stream.__mmWatched = true;
      stream.addEventListener('addtrack', (e) => adoptTrack(el, e.track));
    }
  }

  function audioContext() {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      if (sinkId && ctx.setSinkId) ctx.setSinkId(sinkId).catch(() => {});
      const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
      addEventListener('pointerdown', resume, true);
      addEventListener('keydown', resume, true);
    }
    return ctx;
  }

  function adoptTrack(el, track) {
    if (track.kind !== 'audio' || track.readyState === 'ended') return;
    if (streams.some((s) => s.track === track)) return;
    const receiver = findReceiver(track);
    if (!receiver) { seen.unmatched++; return; } // not from a call we know (e.g. a local preview)
    const c = audioContext();
    const source = c.createMediaStreamSource(new MediaStream([track]));
    const gain = c.createGain();
    source.connect(gain).connect(c.destination);
    takeOverMute(el);
    const s = { el, track, receiver, source, gain, number: nextStreamNumber(), lastStamp: 0, voice: null, target: 1 };
    streams.push(s);
    track.addEventListener('ended', () => dropStream(s));
    renderStatus();
  }

  function nextStreamNumber() {
    let n = 1;
    while (streams.some((s) => s.number === n)) n++;
    return n;
  }

  function dropStream(s) {
    const i = streams.indexOf(s);
    if (i < 0) return;
    streams.splice(i, 1);
    if (s.el) {
      try { s.source.disconnect(); s.gain.disconnect(); } catch (e) {}
      updateElementMute(s.el);
    } else {
      // Meet's own Web Audio chain: leave it in place, at full volume
      const g = audibleGain(s);
      if (g) g.gain.value = 1;
    }
    renderStatus();
  }

  // Meet's element stays playing but silent (Chrome only feeds a remote track into
  // Web Audio while an element plays it). Meet still sees its own muted value.
  function takeOverMute(el) {
    if (el.__mmTaken) return;
    el.__mmTaken = true;
    let pageMuted = mutedDesc.get.call(el);
    Object.defineProperty(el, 'muted', {
      configurable: true,
      get() { return pageMuted; },
      set(v) { pageMuted = !!v; updateElementMute(el); },
    });
    el.__mmPageMuted = () => pageMuted;
    updateElementMute(el);
  }

  function updateElementMute(el) {
    if (!el || !el.__mmTaken) return;
    const ours = ctx && ctx.state === 'running' && streams.some((s) => s.el === el);
    // Until our audio runs, Meet keeps playing as usual, so nobody goes silent.
    mutedDesc.set.call(el, el.__mmPageMuted() || ours);
  }

  // 4. Every tick: who is on each stream, and set its volume.
  // Meet's packets can name two sources at once, so both come back with the same newest
  // timestamp. One is the person talking; the other rides along with every speaker on that
  // stream. So of the tied ones, take the one seen next to the fewest different others.
  const partners = new Map(); // source id -> Set of ids it was tied with
  function currentSource(receiver) {
    let list = receiver.getContributingSources();
    if (!list.length) list = receiver.getSynchronizationSources();
    let newest = -Infinity;
    for (const e of list) if (e.timestamp > newest) newest = e.timestamp;
    const tied = list.filter((e) => e.timestamp === newest);
    if (tied.length < 2) return tied[0] || null;
    for (const a of tied) {
      if (!partners.has(a.source)) partners.set(a.source, new Set());
      for (const b of tied) if (b !== a) partners.get(a.source).add(b.source);
    }
    // Ties between equally known ones: the last in Chrome's list (Chrome lists the
    // source that came first in the packet last; in Meet that is the speaker).
    let best = null;
    for (const e of tied) if (!best || partners.get(e.source).size <= partners.get(best.source).size) best = e;
    return best;
  }

  // Voices of people who left (see hideLeft), by source id: if they talk again
  // (Meet only hides their tile in big calls), they come back as they were.
  const gone = new Map();

  function voiceFor(id) {
    let v = voices.get(id);
    if (!v && gone.has(id)) {
      v = gone.get(id);
      gone.delete(id);
      v.row = null;
      v.seenAt = performance.now();
      voices.set(id, v);
      renderVoices();
    }
    if (!v) {
      v = { id, number: ++voiceCount, name: '', autoName: '', percent: 100, muted: false, level: 0, lastHeard: 0, stream: 0, row: null };
      voices.set(id, v);
      renderVoices();
    }
    return v;
  }

  function tick() {
    const now = performance.now();
    for (const pc of peers) if (pc.signalingState === 'closed') peers.delete(pc);
    for (const s of streams.slice()) {
      if (s.track.readyState === 'ended') { dropStream(s); continue; }
      if (!s.receiver) { tickListened(s, now); continue; }
      const src = currentSource(s.receiver);
      if (!src) continue;
      const v = voiceFor(src.source);
      if (src.timestamp !== s.lastStamp) {
        s.lastStamp = src.timestamp;
        v.level = src.audioLevel || 0;
        if (v.level > 0.01) v.lastHeard = now;
      }
      applyVoice(s, v);
    }
    for (const s of streams) updateElementMute(s.el);
  }

  // A decoded stream from Meet: it is loud when its slot got speech packets a moment
  // earlier, so count how often each slot agrees, and follow the best one.
  function tickListened(s, now) {
    // Listen where the sound goes to the speakers once that is known, else on the analyzer copy.
    const g = audibleGain(s);
    const meter = (g && g.__mmMeter) || s.meter;
    if (meter !== s.meterUsed) {
      s.meterUsed = meter;
      s.delayScores = null; // a different place to listen: measure the delay again
    }
    meter.getFloatTimeDomainData(s.buf);
    let sum = 0;
    for (const x of s.buf) sum += x * x;
    const rms = Math.sqrt(sum / s.buf.length);
    const loud = rms > LOUD_RMS;
    let best = null;
    let bestScore = -Infinity;
    let second = -Infinity;
    for (const slot of slots) {
      const p = slotPacket(slot, now, s.delay);
      const speech = !!(p && p.speech);
      if (loud || speech) s.scores.set(slot, (s.scores.get(slot) || 0) + (loud === speech ? 1 : -1));
      const score = s.scores.get(slot) || 0;
      if (score > bestScore) { second = bestScore; bestScore = score; best = slot; } else if (score > second) second = score;
    }
    // Meet's decoder output N plays the slot with the N-th lowest SSRC (6666, 6667, 6668):
    // seen in every real call. Listening decides when the output isn't known, or when it
    // clearly disagrees (a page whose SSRCs aren't in that order, like the test page).
    const byOrder = slotByOrder(s);
    const heard = best && bestScore >= LINK_SCORE && bestScore - second >= LINK_SCORE / 2 ? best : null;
    const before = s.slot;
    if (heard && (!byOrder || (heard !== byOrder && bestScore >= LINK_SCORE * 4 && (s.scores.get(byOrder) || 0) < 0))) s.slot = heard;
    else if (byOrder) s.slot = byOrder;
    else if (heard) s.slot = heard;
    if (s.slot !== before) s.delayScores = null; // measured against the wrong slot: start over
    if (s.slot) measureDelay(s, now, loud);
    const p = s.slot && slotPacket(s.slot, now, s.delay);
    if (!p) {
      // Not linked yet: leave the sound as Meet plays it. A short gap in the packets of a
      // linked stream keeps the last person's volume (going to 100 % made them jump loud).
      if (!s.slot) {
        s.voice = null;
        setGain(s, 1);
      }
      return;
    }
    const v = voiceFor(p.id);
    v.level = Math.min(1, rms * 4);
    if (loud) v.lastHeard = now;
    s.voice = v;
    v.stream = s.number;
    // Around a speaker change the timing is never exact: for a moment before and after,
    // use the lower of the two volumes, so a turned-down person never comes through loud.
    let target = volumeOf(v);
    for (const near of [slotPacket(s.slot, now, s.delay - SWITCH_GUARD_MS), slotPacket(s.slot, now, s.delay + SWITCH_GUARD_MS)]) {
      if (near && near.id !== p.id) target = Math.min(target, volumeOf(voiceFor(near.id)));
    }
    setGain(s, target);
  }

  function volumeOf(v) {
    return v.muted ? 0 : v.percent / 100;
  }

  function slotByOrder(s) {
    if (!s.out) s.out = decoderOutputOf.get(s.track) || null;
    if (!s.out) return null;
    const ordered = slots.filter((slot) => slot.ssrc != null).sort((a, b) => a.ssrc - b.ssrc);
    return ordered[s.out.output] || null;
  }

  // Meet's decoder holds audio longer as a call goes on (its jitter buffer grows). Try a
  // range of delays and keep the one where "loud now" best matches "speech packet then".
  const DELAYS = [];
  for (let d = 20; d <= 800; d += 20) DELAYS.push(d);
  function measureDelay(s, now, loud) {
    if (!s.delayScores) s.delayScores = new Map();
    for (const d of DELAYS) {
      const p = slotPacket(s.slot, now, d);
      const speech = !!(p && p.speech);
      if (loud || speech) s.delayScores.set(d, (s.delayScores.get(d) || 0) * 0.999 + (loud === speech ? 1 : -1));
    }
    let bestDelay = s.delay;
    let bestScore = s.delayScores.get(s.delay) || 0;
    for (const [d, score] of s.delayScores) if (score > bestScore + 5) { bestScore = score; bestDelay = d; }
    s.delay = bestDelay;
  }

  function applyVoice(s, v) {
    s.voice = v;
    v.stream = s.number;
    const pageMuted = s.el && s.el.__mmPageMuted ? s.el.__mmPageMuted() : false;
    setGain(s, v.muted || pageMuted ? 0 : v.percent / 100);
  }

  // The gain that changes what you hear. For Meet's decoded streams that is our gain on
  // the decoder output they copy, not the one on the analyzer copy (that stays at 100 %).
  function audibleGain(s) {
    if (!s.meter) return s.gain;
    if (!s.out) s.out = decoderOutputOf.get(s.track) || null;
    return s.out && s.out.node.__mmPlay ? s.out.node.__mmPlay[s.out.output] || null : null;
  }

  function setGain(s, target) {
    const g = audibleGain(s);
    if (!g || (target === s.target && g === s.applied)) return;
    s.target = target;
    s.applied = g;
    g.gain.setTargetAtTime(target, g.context.currentTime, 0.01);
  }

  // A name typed in the panel wins over the one found in Meet.
  function displayName(v) {
    return v.name || v.autoName;
  }

  function loadVolume(v) {
    // v8 saved volumes under Meet's button text: move them to the plain name once.
    const old = `Pin ${displayName(v)} to your main screen`;
    if (saved.nameVolumes[old] != null && saved.nameVolumes[displayName(v)] == null) {
      saved.nameVolumes[displayName(v)] = saved.nameVolumes[old];
      delete saved.nameVolumes[old];
      save();
    }
    const known = saved.nameVolumes[displayName(v)];
    if (displayName(v) && known != null) {
      v.percent = known;
      if (v.row) v.row.slider.value = String(known);
    }
  }

  function setName(v, name) {
    v.name = name.trim() === v.autoName ? '' : name.trim();
    loadVolume(v);
    renderRow(v);
    orderRows();
    filterRows();
  }

  function setPercent(v, percent) {
    v.percent = percent;
    if (displayName(v)) {
      saved.nameVolumes[displayName(v)] = percent;
      save();
    }
    renderRow(v);
  }

  // 4b. Names. Meet marks who is talking on their tile and in the People list (both
  // carry data-participant-id). While exactly one voice talks, each participant whose
  // elements change counts for that voice; the one that changes along with a voice is it.
  const NAME_SCORE = 8;      // changes needed before a voice gets a name
  const participants = new Map(); // participant id -> what we saw of it
  function participantFor(el) {
    const id = el.getAttribute('data-participant-id');
    let p = participants.get(id);
    if (!p) {
      p = { id, el, quiet: 0, byVoice: new Map(), classes: new Map() };
      participants.set(id, p);
    }
    p.el = el;
    return p;
  }

  function watchNames() {
    const observer = new MutationObserver((records) => {
      const now = performance.now();
      const talking = [];
      for (const v of voices.values()) if (now - v.lastHeard < TALKING_MS) talking.push(v);
      const touched = new Set();
      for (const r of records) {
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        const pEl = el && el.closest('[data-participant-id]');
        if (!pEl) continue;
        const p = participantFor(pEl);
        touched.add(p);
        if (r.type === 'attributes' && r.attributeName === 'class') countClassChange(p, r.oldValue, el.getAttribute('class'));
      }
      // Once per batch, so a tile with many moving parts doesn't count more.
      for (const p of touched) {
        if (!talking.length) p.quiet++;
        else if (talking.length === 1) p.byVoice.set(talking[0], (p.byVoice.get(talking[0]) || 0) + 1);
      }
    });
    observer.observe(document.documentElement, { subtree: true, attributes: true, attributeOldValue: true, childList: true });
  }

  function countClassChange(p, before, after) {
    const a = new Set((before || '').split(/\s+/));
    const b = new Set((after || '').split(/\s+/));
    for (const c of b) if (c && !a.has(c)) p.classes.set(`+${c}`, (p.classes.get(`+${c}`) || 0) + 1);
    for (const c of a) if (c && !b.has(c)) p.classes.set(`-${c}`, (p.classes.get(`-${c}`) || 0) + 1);
  }

  // The words on a participant's elements that look like a name (not icon names like mic_off).
  function nameCandidates(el) {
    const found = [];
    const self = el.querySelector('[data-self-name]');
    if (self && self.textContent.trim()) found.push(self.textContent.trim());
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && found.length < 6; n = walker.nextNode()) {
      const t = n.textContent.trim();
      if (t.length < 2 || t.length > 60 || /^[a-z0-9_]+$/.test(t) || found.includes(t)) continue;
      found.push(t);
    }
    return found;
  }

  // Meet's tile also holds button texts with the name in them ("Pin Alex Rivera to your
  // main screen", "More options for Alex Rivera"): those words come off first, then the
  // name is the text most others contain. A shared screen's tile only has "Unpin Sam
  // Patel's presentation", which so becomes "Sam Patel's presentation".
  function cleanName(text) {
    return text.replace(/^(Unpin|Pin|More options for) /, '').replace(/ to your main screen$/, '').trim();
  }

  function pickName(found) {
    const candidates = found.map(cleanName).filter(Boolean);
    let best = null;
    let bestCount = -1;
    candidates.forEach((c, i) => {
      const count = candidates.filter((o, j) => j !== i && o.includes(c)).length;
      if (count > bestCount || (count === bestCount && c.length < best.length)) { best = c; bestCount = count; }
    });
    return bestCount > 0 ? best : candidates[0];
  }

  function assignNames() {
    // All elements of one person (tile, People list) share their id: add them up.
    for (const v of voices.values()) {
      let best = null;
      let bestScore = 0;
      let second = 0;
      for (const p of participants.values()) {
        const score = p.byVoice.get(v) || 0;
        if (score > bestScore) { second = bestScore; bestScore = score; best = p; } else if (score > second) second = score;
      }
      if (!best || bestScore < NAME_SCORE || bestScore < second * 2) continue;
      if (v.participantId !== best.id) {
        v.participantId = best.id;
        v.seenAt = performance.now();
      }
      const name = pickName(nameCandidates(best.el));
      if (!name || name === v.autoName) continue;
      v.autoName = name;
      if (!v.name) loadVolume(v);
      renderRow(v);
    }
    // Someone who leaves and joins again gets a new id, so a second voice with their name:
    // keep the one heard last, drop the other (its volume lives on under the name).
    const byName = new Map();
    for (const v of [...voices.values()]) {
      if (!v.autoName) continue;
      const other = byName.get(v.autoName);
      if (!other) { byName.set(v.autoName, v); continue; }
      const older = other.lastHeard <= v.lastHeard ? other : v;
      removeVoice(older);
      byName.set(v.autoName, older === other ? v : other);
    }
    // A name that just arrived can be a pinned one, or match the search.
    orderRows();
    filterRows();
  }

  function removeVoice(v) {
    voices.delete(v.id);
    if (v.row) v.row.row.remove();
    for (const s of streams) if (s.voice === v) s.voice = null;
    renderVoices();
  }

  // Someone left when their tile and People-list entry (data-participant-id) are gone
  // and they haven't talked, both for 30 s. Their voice is kept aside in `gone`.
  const LEFT_MS = 30000;
  function hideLeft() {
    const now = performance.now();
    for (const v of [...voices.values()]) {
      if (!v.participantId) continue;
      if (document.querySelector(`[data-participant-id="${CSS.escape(v.participantId)}"]`)) {
        v.seenAt = now;
        continue;
      }
      const quiet = !v.lastHeard || now - v.lastHeard > LEFT_MS;
      if (now - v.seenAt > LEFT_MS && quiet) {
        removeVoice(v);
        gone.set(v.id, v);
      }
    }
  }

  // 5. The panel. Built with createElement and style properties only:
  // Meet's page rules (Trusted Types) block innerHTML.
  function make(tag, style, props) {
    const e = document.createElement(tag);
    // No focus frames around clicked buttons, sliders and fields.
    if (tag === 'button' || tag === 'input') e.style.outline = 'none';
    if (style) Object.assign(e.style, style);
    if (props) Object.assign(e, props);
    return e;
  }

  // The sliders of the extension icon (as in tools/make-icons.js), drawn as SVG on its
  // 128 grid: a page script can't load the extension's own PNGs. The blue is the button.
  function iconSvg(size) {
    const ns = 'http://www.w3.org/2000/svg';
    const shape = (tag, attrs) => {
      const e = document.createElementNS(ns, tag);
      for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, String(val));
      return e;
    };
    const svg = shape('svg', { width: size, height: size, viewBox: '0 0 128 128' });
    const tracks = [40, 64, 88];
    const knobs = [82, 44, 64];
    tracks.forEach((x, i) => {
      svg.append(shape('rect', { x: x - 4, y: 26, width: 8, height: 76, fill: '#98c0f5' }));
      svg.append(shape('circle', { cx: x, cy: knobs[i], r: 13, fill: '#fff' }));
    });
    return svg;
  }

  function mountUi() {
    // The round button; placeButton puts it where it was dragged to (by default bottom left,
    // next to Meet's Gemini button: the top right covers Meet's side panel buttons).
    const host = make('div', { position: 'fixed', width: '40px', height: '40px', zIndex: '2147483647' });
    const root = host.attachShadow({ mode: 'closed' });
    // Thin rounded grey scrollbar without arrows, like Meet's own panels. Scrollbar parts
    // can only be styled from a stylesheet; a constructed one needs no <style> tag.
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #3c4043; border-radius: 4px; border: 2px solid #202124; }
        ::-webkit-scrollbar-thumb:hover { background: #5f6368; }
        ::-webkit-scrollbar-button { display: none; }
        :focus, :focus-visible { outline: none; }
      `);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {} // without it the plain dark scrollbar stays
    // Keep typing in our fields away from Meet's keyboard shortcuts.
    host.addEventListener('keydown', (e) => e.stopPropagation());

    const font = { fontFamily: '"Google Sans", Roboto, Arial, sans-serif', fontSize: '13px', color: '#e8eaed' };
    const toggle = make('button', {
      ...font, width: '40px', height: '40px', borderRadius: '50%', border: 'none', cursor: 'pointer',
      background: '#1a73e8', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0',
      boxShadow: '0 2px 6px rgba(0,0,0,.4)', touchAction: 'none',
    }, { title: 'Meet Mixer: click to open or close, drag to move' });
    toggle.append(iconSvg(30));
    // Next to the button, opening toward the free side of the window (see placeButton).
    const panel = make('div', {
      ...font, position: 'absolute', width: '300px', padding: '12px', borderRadius: '12px', background: '#202124',
      boxShadow: '0 4px 16px rgba(0,0,0,.5)', display: saved.open ? 'block' : 'none', overflowY: 'auto',
      colorScheme: 'dark', // the scrollbar's own look is in the panel's stylesheet below
    });
    const title = make('div', { fontSize: '15px', fontWeight: '500', marginBottom: '2px', userSelect: 'none' }, { textContent: `Meet Mixer · v${VERSION}` });
    const status = make('div', { color: '#9aa0a6', fontSize: '12px', marginBottom: '10px' });
    const diag = make('div', { color: '#9aa0a6', fontSize: '11px' });
    const copy = make('button', {
      background: '#3c4043', border: 'none', borderRadius: '6px', color: '#8ab4f8', font: 'inherit', fontSize: '12px',
      cursor: 'pointer', padding: '4px 10px', margin: '6px 0 0',
    }, { textContent: 'Copy details', title: 'Copies what Meet Mixer sees, to add to a bug report' });
    const copyBox = make('textarea', { width: '100%', height: '80px', display: 'none', fontSize: '11px', marginTop: '6px' }, { readOnly: true });
    copy.addEventListener('click', async () => {
      const text = JSON.stringify(await collectDetails(), null, 1);
      try {
        // The clipboard can hang waiting for a permission: give up after 1.5 s.
        await Promise.race([
          navigator.clipboard.writeText(text),
          new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
        ]);
        copy.textContent = 'Copied';
      } catch (e) {
        // No clipboard access: show the text to copy by hand.
        copyBox.value = text;
        copyBox.style.display = 'block';
        copyBox.select();
        copy.textContent = 'Press Ctrl+C to copy';
      }
      setTimeout(() => { copy.textContent = 'Copy details'; }, 4000);
    });
    // Search: always shown.
    const search = make('input', {
      width: '100%', boxSizing: 'border-box', background: '#303134', border: '1px solid #5f6368', borderRadius: '8px',
      color: '#e8eaed', font: 'inherit', padding: '6px 10px', marginBottom: '8px', outline: 'none', display: 'block',
    }, { type: 'search', placeholder: 'Search people', title: 'Show only people whose name contains this' });
    search.addEventListener('input', filterRows);
    const list = make('div');
    const empty = make('div', { color: '#9aa0a6', padding: '8px 0' }, { textContent: 'Nobody has talked yet.' });
    list.append(empty);
    // Technical lines for finding out how Meet plays audio: hidden, shown by a double-click
    // on the title (to send "Copy details" when something goes wrong).
    const tech = make('div', { display: saved.tech ? 'block' : 'none', margin: '-4px 0 10px' });
    tech.append(diag, copy, copyBox);
    title.title = 'Double-click for technical details';
    title.addEventListener('dblclick', () => {
      saved.tech = tech.style.display === 'none';
      tech.style.display = saved.tech ? 'block' : 'none';
      save();
    });
    panel.append(title, status, tech, search, list);
    root.append(toggle, panel);

    // Click opens or closes; dragging (more than a few pixels) moves the button instead.
    let drag = null;
    toggle.addEventListener('pointerdown', (e) => {
      drag = { sx: e.clientX, sy: e.clientY, x: host.offsetLeft, y: host.offsetTop, moved: false };
      toggle.setPointerCapture(e.pointerId);
    });
    toggle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      saved.button = { x: drag.x + dx, y: drag.y + dy };
      placeButton();
    });
    toggle.addEventListener('pointerup', () => {
      if (!drag) return;
      if (drag.moved) save(); else togglePanel();
      drag = null;
    });
    // Enter or Space on the focused button (a click without a pointer).
    toggle.addEventListener('click', (e) => { if (e.detail === 0) togglePanel(); });
    addEventListener('resize', () => placeButton());

    document.documentElement.append(host);
    ui = { host, panel, status, diag, search, list, empty };
    placeButton();
    watchNames();
    renderVoices();
    renderStatus();
  }

  // Everything about the call's audio path, as plain data: counts and ids, never names. People
  // paste this into public bug reports, so a name found in Meet shows as [name] and a text with
  // no name found only as its length.
  const hideName = (texts) => {
    const name = pickName(texts);
    return texts.map((t) => (name && t.includes(name) ? t.split(name).join('[name]') : `[${t.length} letters]`));
  };
  async function collectDetails() {
    const trackInfo = (t) => {
      let depth = 0;
      for (let c = cloneOf.get(t); c; c = cloneOf.get(c)) depth++;
      return { id: t.id.slice(0, 8), type: t.constructor.name, label: t.label.slice(0, 40), state: t.readyState, muted: t.muted, copies: depth, fromCall: !!findReceiver(t) };
    };
    const connections = [];
    for (const pc of peers) {
      const receivers = [];
      for (const r of pc.getReceivers()) {
        if (!r.track || r.track.kind !== 'audio') continue;
        receivers.push({
          track: trackInfo(r.track),
          sync: r.getSynchronizationSources().length,
          contributing: r.getContributingSources().length,
          // The raw source lists: which ids come back, how fresh, how loud.
          sources: [...r.getContributingSources().map((e) => ({ csrc: e.source, agoMs: Math.round(performance.timeOrigin + performance.now() - e.timestamp), level: e.audioLevel })),
            ...r.getSynchronizationSources().map((e) => ({ ssrc: e.source, agoMs: Math.round(performance.timeOrigin + performance.now() - e.timestamp), level: e.audioLevel }))],
          picked: (currentSource(r) || {}).source,
          hasTransform: !!r.transform,
        });
      }
      const inbound = [];
      try {
        const stats = await pc.getStats();
        stats.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            inbound.push({ ssrc: s.ssrc, packets: s.packetsReceived, bytes: s.bytesReceived, level: s.audioLevel, samples: s.totalSamplesReceived });
          }
        });
      } catch (e) {}
      connections.push({ state: pc.connectionState, inFrame: pc.constructor !== window.RTCPeerConnection, receivers, inbound });
    }
    return {
      version: VERSION,
      connections,
      webAudioTracks: details.webAudioTracks.map(trackInfo),
      frames: hookedFrames.length,
      seen,
      encodedStreams: details.encodedStreams,
      transforms: details.transforms,
      generators: details.generators,
      processors: details.processors,
      worklets: details.worklets,
      workers: details.workers,
      audioContexts: graph.contexts.map((c, i) => ({ n: i, type: c.constructor.name, state: c.state, rate: c.sampleRate, ours: c === ctx })),
      audioWorkletNodes: graph.worklets,
      audioGraph: [...graph.edges].map(([edge, times]) => (times > 1 ? `${edge} ×${times}` : edge)),
      participants: [...participants.values()].map((p) => ({
        id: String(p.id).slice(-8),
        names: hideName(nameCandidates(p.el)),
        quiet: p.quiet,
        byVoice: Object.fromEntries([...p.byVoice].map(([v, n]) => [v.number, n])),
        classes: [...p.classes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} ×${n}`),
      })),
      voiceNames: [...voices.values()].map((v) => ({ number: v.number, typed: !!v.name, fromMeet: !!v.autoName })),
      ourAudio: ctx ? ctx.state : 'none',
      slots: slots.map((slot) => {
        const last = slot.recent[slot.recent.length - 1];
        return { number: slot.number, frames: slot.frames, lastBytes: slot.bytes, lastAgoMs: last ? Math.round(performance.now() - last.at) : null, speaker: last ? last.id : null };
      }),
      streams: streams.map((s) => ({
        number: s.number,
        how: s.el ? 'element' : s.receiver ? 'web audio' : 'decoded by Meet',
        slot: s.slot ? s.slot.number : null,
        scores: s.meter ? slots.map((slot) => s.scores.get(slot) || 0) : null,
        slotSsrc: s.slot ? s.slot.ssrc : null,
        delayMs: s.meter ? s.delay : null,
        voice: s.voice ? s.voice.number : null,
        volume: s.target,
        decoderOutput: s.out ? s.out.output : null,
        controlsSound: !!audibleGain(s),
      })),
    };
  }

  // The round button on the page and the toolbar icon (background.js) both call this.
  function togglePanel() {
    if (!ui) return;
    saved.open = ui.panel.style.display === 'none';
    ui.panel.style.display = saved.open ? 'block' : 'none';
    save();
    sizeList(); // rows have no height while the panel is hidden
  }

  // The button where it was dragged to (kept inside the window); the panel opens down when
  // the button is in the top half, up in the bottom half, and leftwards on the right side.
  function placeButton() {
    if (!ui) return;
    const w = innerWidth;
    const h = innerHeight;
    const pos = saved.button || { x: 64, y: h - 60 };
    const x = Math.min(Math.max(8, pos.x), w - 48);
    const y = Math.min(Math.max(8, pos.y), h - 48);
    ui.host.style.left = `${x}px`;
    ui.host.style.top = `${y}px`;
    const down = y + 20 < h / 2;
    const right = x + 20 > w / 2;
    const p = ui.panel.style;
    p.top = down ? '48px' : '';
    p.bottom = down ? '' : '48px';
    p.left = right ? '' : '0';
    p.right = right ? '0' : '';
    p.maxHeight = `${Math.max(160, (down ? h - y - 48 : y) - 16)}px`; // never past the window edge
  }

  // Up to 6 people show at once; more scroll inside the list (title and search stay put).
  const ROWS_SHOWN = 6;
  function sizeList() {
    if (!ui) return;
    const shown = [...voices.values()].filter((v) => v.row && v.row.row.style.display !== 'none');
    const height = shown.length ? shown[0].row.row.offsetHeight : 0;
    if (shown.length > ROWS_SHOWN && height) {
      ui.list.style.maxHeight = `${height * ROWS_SHOWN}px`;
      ui.list.style.overflowY = 'auto';
      // The scrollbar sits in the panel's edge, with a small gap to the rows.
      ui.list.style.marginRight = '-10px';
      ui.list.style.paddingRight = '12px';
    } else if (shown.length <= ROWS_SHOWN) {
      ui.list.style.maxHeight = '';
      ui.list.style.overflowY = '';
      ui.list.style.marginRight = '';
      ui.list.style.paddingRight = '';
    }
  }

  function renderStatus() {
    if (!ui) return;
    let meetAudio = 0;
    for (const pc of peers) {
      for (const r of pc.getReceivers()) {
        // Only receivers that actually get sound (Meet keeps idle ones around too).
        if (r.track && r.track.kind === 'audio' && r.track.readyState === 'live' && r.getSynchronizationSources().length) meetAudio++;
      }
    }
    const linked = streams.filter((s) => s.receiver || s.slot).length;
    let text = `${linked} of ${streams.length} audio streams linked · ${voices.size} voices`;
    if (linked < streams.length) text += ' · linking while people talk';
    if (ctx && ctx.state !== 'running' && streams.some((s) => s.el)) text += ' · click anywhere in Meet to start';
    if (meetAudio > 0 && streams.length === 0) text += ' · Meet plays its audio another way, not hooked yet';
    ui.status.textContent = text;
    // What the extension sees, to find out why streams are missing.
    let media = 0;
    let withStream = 0;
    for (const w of [window, ...hookedFrames]) {
      try {
        for (const m of w.document.querySelectorAll('audio, video')) {
          media++;
          if (m.srcObject) withStream++;
        }
      } catch (e) {}
    }
    let audioReceivers = 0;
    for (const pc of peers) for (const r of pc.getReceivers()) if (r.track && r.track.kind === 'audio') audioReceivers++;
    ui.diag.textContent = `Seen: ${peers.size} connections, ${audioReceivers} audio receivers · ${hookedFrames.length} frames · `
      + `${media} media elements, ${withStream} with a stream, ${seen.srcObjects} streams set · ${seen.webAudio} Web Audio sources · ${seen.unmatched} not from a known call · ${slots.length} encoded slots`;
  }

  function renderVoices() {
    if (!ui) return;
    ui.empty.style.display = voices.size ? 'none' : 'block';
    for (const v of voices.values()) if (!v.row) buildRow(v);
    orderRows();
    filterRows();
  }

  // Pinned people are remembered by name; one without a name yet stays pinned for this call.
  function isPinned(v) {
    return v.pinned || (!!displayName(v) && saved.pinned.includes(displayName(v)));
  }

  function togglePin(v) {
    const pin = !isPinned(v);
    v.pinned = pin;
    const name = displayName(v);
    if (name) {
      saved.pinned = saved.pinned.filter((n) => n !== name);
      if (pin) saved.pinned.push(name);
      save();
    }
    renderRow(v);
    orderRows();
  }

  // Pinned people on top, everyone else in the order they first talked. Rows never move
  // by who is talking (on purpose: they would jump around all the time).
  function orderRows() {
    if (!ui) return;
    const sorted = [...voices.values()].filter((v) => v.row)
      .sort((a, b) => (isPinned(b) - isPinned(a)) || (a.number - b.number));
    let prev = ui.empty;
    for (const v of sorted) {
      if (prev.nextSibling !== v.row.row) prev.after(v.row.row);
      prev = v.row.row;
    }
  }

  function filterRows() {
    if (!ui) return;
    const q = ui.search.value.trim().toLowerCase();
    for (const v of voices.values()) {
      if (!v.row) continue;
      const label = (displayName(v) || `Voice ${v.number}`).toLowerCase();
      v.row.row.style.display = !q || label.includes(q) ? '' : 'none';
    }
    sizeList();
  }

  function buildRow(v) {
    const row = make('div', { padding: '8px 0', borderTop: '1px solid #3c4043' });
    const top = make('div', { display: 'flex', alignItems: 'center', gap: '6px' });
    const dot = make('span', { width: '8px', height: '8px', borderRadius: '50%', background: '#5f6368', flex: 'none' });
    const name = make('input', {
      flex: '1', minWidth: '0', background: 'transparent', border: 'none', borderBottom: '1px solid transparent',
      color: '#e8eaed', font: 'inherit', padding: '2px 0', outline: 'none',
    }, { placeholder: `Voice ${v.number}`, value: displayName(v), title: 'Name from Meet, or type your own; its volume is remembered for next time' });
    name.addEventListener('focus', () => { v.editing = true; name.style.borderBottomColor = '#8ab4f8'; });
    name.addEventListener('blur', () => { v.editing = false; name.style.borderBottomColor = 'transparent'; });
    name.addEventListener('change', () => setName(v, name.value));
    const percent = make('button', {
      background: 'none', border: 'none', color: '#e8eaed', font: 'inherit', cursor: 'pointer', width: '44px', textAlign: 'right', padding: '0',
    }, { title: 'Back to 100 %' });
    percent.addEventListener('click', () => { slider.value = '100'; setPercent(v, 100); });
    const mute = make('button', {
      background: '#3c4043', border: 'none', borderRadius: '6px', color: '#e8eaed', cursor: 'pointer', width: '28px', height: '24px', padding: '0',
    });
    mute.addEventListener('click', () => { v.muted = !v.muted; renderRow(v); });
    const pin = make('button', {
      background: 'none', border: 'none', cursor: 'pointer', width: '24px', height: '24px', padding: '0', fontSize: '14px',
    });
    pin.addEventListener('click', () => togglePin(v));
    top.append(dot, name, percent, pin, mute);

    const meter = make('div', { height: '3px', background: '#3c4043', borderRadius: '2px', margin: '6px 0 2px', overflow: 'hidden' });
    const fill = make('div', { height: '100%', width: '0%', background: '#81c995', transition: 'width 80ms linear' });
    meter.append(fill);
    const slider = make('input', { width: '100%', accentColor: '#8ab4f8', margin: '4px 0 0' }, {
      type: 'range', min: '0', max: String(MAX_PERCENT), step: '5', value: String(v.percent),
    });
    slider.addEventListener('input', () => setPercent(v, Number(slider.value)));
    row.append(top, meter, slider);
    ui.list.append(row);
    v.row = { row, dot, name, percent, pin, mute, fill, slider };
    renderRow(v);
  }

  function renderRow(v) {
    if (!v.row) return;
    if (!v.editing) v.row.name.value = displayName(v);
    v.row.percent.textContent = `${v.percent} %`;
    v.row.mute.textContent = v.muted ? '🔇' : '🔊';
    v.row.mute.title = v.muted ? 'Unmute' : 'Mute';
    v.row.pin.textContent = '📌';
    v.row.pin.style.opacity = isPinned(v) ? '1' : '0.3';
    v.row.pin.title = isPinned(v) ? 'Unpin' : 'Pin to the top';
    v.row.slider.style.opacity = v.muted ? '0.4' : '1';
  }

  function renderLive() {
    const now = performance.now();
    for (const v of voices.values()) {
      if (!v.row) continue;
      const talking = now - v.lastHeard < TALKING_MS;
      v.row.dot.style.background = talking ? '#81c995' : '#5f6368';
      v.row.fill.style.width = talking ? `${Math.min(100, Math.round(Math.sqrt(v.level) * 100))}%` : '0%';
    }
    if (++liveCount % 10 === 0) {
      assignNames();
      hideLeft();
    }
    renderStatus();
  }
  let liveCount = 0;

  setInterval(tick, TICK_MS);
  setInterval(renderLive, 100);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountUi);
  else mountUi();

  window.__meetMixer = { peers, streams, voices, gone, voiceFor, collectDetails, togglePanel, currentSource, get ctx() { return ctx; } };
})();
