import { useEffect, useRef, useState, useCallback } from "react";

declare global {
  interface Window {
    Hands: any;
    drawConnectors: any;
    drawLandmarks: any;
    HAND_CONNECTIONS: any;
  }
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const STABLE_THRESHOLD = 12;
const MAX_WORD_LEN = 16;

interface LM { x: number; y: number; z: number }

/* ── Geometry helpers ── */
function dist(a: LM, b: LM) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/* ── Finger extension detection ──
   Landmarks:
     Wrist=0
     Thumb:  CMC=1 MCP=2 IP=3  TIP=4
     Index:  MCP=5 PIP=6 DIP=7 TIP=8
     Middle: MCP=9 PIP=10 DIP=11 TIP=12
     Ring:   MCP=13 PIP=14 DIP=15 TIP=16
     Pinky:  MCP=17 PIP=18 DIP=19 TIP=20
*/
function fingers(lm: LM[]) {
  // Non-thumb: TIP above PIP (smaller y = higher on screen)
  const index  = lm[8].y  < lm[6].y  - 0.02;
  const middle = lm[12].y < lm[10].y - 0.02;
  const ring   = lm[16].y < lm[14].y - 0.02;
  const pinky  = lm[20].y < lm[18].y - 0.02;
  // Thumb: tip far from index MCP means extended
  const palmSz = dist(lm[0], lm[9]) || 0.15;
  const thumb  = dist(lm[4], lm[5]) / palmSz > 0.55;
  return { index, middle, ring, pinky, thumb };
}

/* ── ASL letter detection ── */
function detectLetter(lm: LM[]): string {
  if (!lm || lm.length < 21) return "";

  const { index, middle, ring, pinky, thumb } = fingers(lm);
  const palmSz = dist(lm[0], lm[9]) || 0.15;
  const d = (a: number, b: number) => dist(lm[a], lm[b]) / palmSz;

  const tI = d(4, 8);   // thumb ↔ index tip
  const tM = d(4, 12);  // thumb ↔ middle tip
  const iM = d(8, 12);  // index ↔ middle tip

  // ── Y: thumb + pinky ─────────────────────────
  if (thumb && !index && !middle && !ring && pinky) return "Y";

  // ── I: pinky only ────────────────────────────
  if (!thumb && !index && !middle && !ring && pinky) return "I";

  // ── B: all four fingers up, thumb tucked ─────
  if (!thumb && index && middle && ring && pinky) return "B";

  // ── F: middle+ring+pinky up, index+thumb circle
  if (!index && middle && ring && pinky && tI < 0.45) return "F";

  // ── W: index + middle + ring ─────────────────
  if (index && middle && ring && !pinky) return "W";

  // ── L: index up + thumb out ──────────────────
  if (thumb && index && !middle && !ring && !pinky) return "L";

  // ── K: index + middle + thumb ────────────────
  if (thumb && index && middle && !ring && !pinky) return "K";

  // ── V / U: index + middle (no thumb) ─────────
  if (!thumb && index && middle && !ring && !pinky) {
    return iM > 0.45 ? "V" : "U";
  }

  // ── D / G: index only ────────────────────────
  if (index && !middle && !ring && !pinky) {
    // D: other fingers curved close to thumb
    return (tM < 0.55 && !thumb) ? "D" : "G";
  }

  // ── F fallback: middle+ring+pinky (thumb not touching) ─
  if (!index && middle && ring && pinky) return "F";

  // ── No fingers extended ──────────────────────
  if (!index && !middle && !ring && !pinky) {
    // C: open curve — wide gap between thumb and index
    if (tI > 0.5 && tI < 0.95 && tM > 0.45) return "C";
    // O: round — all tips close to thumb tip
    if (tI < 0.45 && tM < 0.55) return "O";
    // A: fist, thumb out to side
    if (thumb && tI > 0.35) return "A";
    // S: fist, thumb crosses over fingers
    if (!thumb && tI < 0.45) return "S";
    // E: fingers hooked (tips close to pips vertically)
    const hooked = Math.abs(lm[8].y - lm[6].y) < 0.1
                && Math.abs(lm[12].y - lm[10].y) < 0.1;
    if (hooked) return "E";
    return "A";
  }

  return "";
}

/* ── Main component ── */
export default function SignLanguageApp() {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handsRef  = useRef<any>(null);
  const stableCountRef = useRef(0);
  const lastLetterRef  = useRef("");
  const addLetterRef   = useRef<(l: string) => void>(() => {});

  const [currentLetter, setCurrentLetter] = useState("");
  const [currentWord,   setCurrentWord]   = useState("");
  const [sentence,      setSentence]      = useState("");
  const [cameraActive,  setCameraActive]  = useState(false);
  const [mpReady,       setMpReady]       = useState(false);

  const addLetter = useCallback((letter: string) => {
    if (!letter) return;
    if (letter === lastLetterRef.current) {
      stableCountRef.current++;
    } else {
      stableCountRef.current = 0;
      lastLetterRef.current  = letter;
    }
    if (stableCountRef.current === STABLE_THRESHOLD)
      setCurrentWord((w) => w.length < MAX_WORD_LEN ? w + letter : w);
  }, []);

  useEffect(() => { addLetterRef.current = addLetter; }, [addLetter]);

  // Wait for MediaPipe CDN scripts
  useEffect(() => {
    let tries = 0;
    const id = setInterval(() => {
      if (window.Hands && window.drawConnectors && window.HAND_CONNECTIONS) {
        clearInterval(id); setMpReady(true);
      } else if (++tries > 60) clearInterval(id);
    }, 200);
    return () => clearInterval(id);
  }, []);

  // Init MediaPipe + camera
  useEffect(() => {
    if (!mpReady) return;

    const hands = new window.Hands({
      locateFile: (f: string) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
    });
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.75,
      minTrackingConfidence: 0.75,
    });

    hands.onResults((results: any) => {
      const canvas = canvasRef.current;
      const video  = videoRef.current;
      if (!canvas || !video) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 480;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (results.multiHandLandmarks?.length > 0) {
        const lm = results.multiHandLandmarks[0];
        window.drawConnectors(ctx, lm, window.HAND_CONNECTIONS,
          { color: "#2dd4bf", lineWidth: 2.5 });
        window.drawLandmarks(ctx, lm,
          { color: "#38bdf8", fillColor: "#0b0f14", lineWidth: 1, radius: 5 });
        const letter = detectLetter(lm);
        setCurrentLetter(letter);
        addLetterRef.current(letter);
      } else {
        setCurrentLetter("");
        stableCountRef.current = 0;
        lastLetterRef.current  = "";
      }
    });

    handsRef.current = hands;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: "user" },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCameraActive(true);
          const loop = async () => {
            if (videoRef.current && handsRef.current)
              await handsRef.current.send({ image: videoRef.current });
            requestAnimationFrame(loop);
          };
          requestAnimationFrame(loop);
        }
      } catch (err) { console.error("Camera error:", err); }
    })();

    return () => {
      videoRef.current?.srcObject &&
        (videoRef.current.srcObject as MediaStream)
          .getTracks().forEach((t) => t.stop());
    };
  }, [mpReady]);

  const handleSpace = useCallback(() => {
    setCurrentWord((w) => { if (w) setSentence((s) => s + w + " "); return ""; });
    stableCountRef.current = 0; lastLetterRef.current = "";
  }, []);

  const handleBackspace = useCallback(() =>
    setCurrentWord((w) => w.slice(0, -1)), []);

  const handleClear = useCallback(() => {
    setCurrentWord(""); setSentence(""); setCurrentLetter("");
    stableCountRef.current = 0; lastLetterRef.current = "";
  }, []);

  const handleSpeak = useCallback(() => {
    const text = (sentence + currentWord).trim();
    if (!text) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }, [sentence, currentWord]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.code === "Space")     { e.preventDefault(); handleSpace();     }
      if (e.code === "Backspace") { e.preventDefault(); handleBackspace(); }
      if (e.code === "Escape")    handleClear();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handleSpace, handleBackspace, handleClear]);

  const isActive = cameraActive && mpReady;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 11V6a2 2 0 0 0-4 0v5"/>
              <path d="M14 10V4a2 2 0 0 0-4 0v6"/>
              <path d="M10 10.5V6a2 2 0 0 0-4 0v8"/>
              <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
            </svg>
          </div>
          <div className="brand-text">
            <h1>Sign Language Recognition</h1>
            <p>Real-time ASL hand sign detection powered by MediaPipe</p>
          </div>
        </div>
        <div className={`status-pill${isActive ? " active" : ""}`}>
          <span className="status-dot"/>
          <span>
            {!mpReady ? "Loading MediaPipe…"
              : !cameraActive ? "Starting camera…" : "Live"}
          </span>
        </div>
      </header>

      <main className="app-main">
        {/* ── Video ── */}
        <section className="video-card">
          <div className="video-wrap">
            {!cameraActive && (
              <div className="video-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z"/>
                </svg>
                <span>
                  {!mpReady ? "Loading MediaPipe…" : "Requesting camera access…"}
                </span>
              </div>
            )}
            <video ref={videoRef} playsInline muted
              style={{ display: cameraActive ? "block" : "none" }}/>
            <canvas ref={canvasRef}
              style={{ display: cameraActive ? "block" : "none" }}/>
            <div className="video-overlay">
              <div className="overlay-letter">{currentLetter || "—"}</div>
              <div className="overlay-label">Detected Sign</div>
            </div>
          </div>
          <div className="video-footer">
            <div className="metric">
              <span className="metric-label">Current Letter</span>
              <span className="metric-value">{currentLetter || "—"}</span>
            </div>
            <div className="metric">
              <span className="metric-label">Status</span>
              <span className="metric-value"
                style={{ fontSize: "0.9rem",
                  color: isActive ? "var(--success)" : "var(--warning)" }}>
                {isActive ? "Detecting" : "Loading"}
              </span>
            </div>
          </div>
        </section>

        {/* ── Controls ── */}
        <section className="text-panel">
          <div className="panel-header">
            <h2>Recognized Text</h2>
            <span className="panel-tag">Live</span>
          </div>

          <div className="word-display">
            {currentWord ||
              <span className="placeholder">Start signing to build a word…</span>}
          </div>

          <div className="sentence-display">
            {sentence ||
              <span className="placeholder">Your sentence will appear here.</span>}
          </div>

          <div className="controls">
            <button className="btn" onClick={handleSpace} title="Space (Spacebar)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 7h18M3 17h18"/>
              </svg>
              Space
            </button>
            <button className="btn" onClick={handleBackspace} title="Delete (Backspace)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/>
                <line x1="18" y1="9" x2="12" y2="15"/>
                <line x1="12" y1="9" x2="18" y2="15"/>
              </svg>
              Delete
            </button>
            <button className="btn btn-accent" onClick={handleSpeak}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
              </svg>
              Speak
            </button>
            <button className="btn btn-danger" onClick={handleClear} title="Clear (Escape)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              Clear
            </button>
          </div>

          <div className="alphabet-grid">
            {ALPHABET.map((letter) => (
              <div key={letter}
                className={`letter-chip${currentLetter === letter ? " active" : ""}`}>
                {letter}
              </div>
            ))}
          </div>

          <div className="hint-box">
            <strong>Best accuracy tips:</strong> Hold hand flat, palm facing camera, in good light. Hold each sign still for ~1 second.
            <br/>
            <strong>Keys:</strong> Space → finish word &nbsp;|&nbsp; Backspace → delete &nbsp;|&nbsp; Esc → clear
          </div>
        </section>
      </main>

      <footer className="app-footer">
        Built with React, MediaPipe &amp; Web Speech API — runs entirely in your browser.
      </footer>
    </div>
  );
}
