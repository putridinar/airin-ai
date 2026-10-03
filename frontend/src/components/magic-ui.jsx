import { useCallback, useEffect, useId, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

export function AnimatedGradientText({ children, className = "" }) {
  return (
    <span className={`magic-gradient-text ${className}`.trim()}>
      {children}
    </span>
  );
}

export function KineticText({ text, className = "", ...props }) {
  return (
    <h2 {...props} className={`kinetic-text ${className}`.trim()}>
      {Array.from(text, (character, index) => (
        <span key={`${index}-${character}`} aria-hidden="true">
          {character === " " ? "\u00a0" : character}
        </span>
      ))}
      <span className="sr-only">{text}</span>
    </h2>
  );
}

export function TypingAnimation({
  text,
  onComplete,
  typeSpeed = Math.min(12, 2400 / Math.max(Array.from(text).length, 1)),
  showCursor = true,
}) {
  const [visibleLength, setVisibleLength] = useState(0);
  const reduceMotion = useReducedMotion();
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const characters = Array.from(text);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    completedRef.current = false;
    setVisibleLength(0);
  }, [text]);

  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onCompleteRef.current?.();
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      setVisibleLength(characters.length);
      complete();
      return undefined;
    }

    if (visibleLength >= characters.length) {
      complete();
      return undefined;
    }

    const timeout = window.setTimeout(
      () => setVisibleLength((length) => length + 1),
      typeSpeed,
    );
    return () => window.clearTimeout(timeout);
  }, [characters.length, complete, reduceMotion, typeSpeed, visibleLength]);

  return (
    <span className="magic-typing-animation" aria-live="off">
      {characters.slice(0, visibleLength).join("")}
      {showCursor && visibleLength < characters.length && (
        <span className="magic-typing-cursor" aria-hidden="true">
          ▍
        </span>
      )}
    </span>
  );
}

export function AnimatedGridPattern({
  className = "",
  cellSize = 40,
  squareCount = 32,
}) {
  const patternId = useId();
  const containerRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [squares, setSquares] = useState([]);
  const reduceMotion = useReducedMotion();

  const randomPosition = useCallback(
    () => [
      Math.floor((Math.random() * dimensions.width) / cellSize),
      Math.floor((Math.random() * dimensions.height) / cellSize),
    ],
    [cellSize, dimensions.height, dimensions.width],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;

    const observer = new ResizeObserver(([entry]) => {
      setDimensions({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (dimensions.width && dimensions.height) {
      setSquares(
        Array.from({ length: squareCount }, (_, id) => ({
          id,
          position: randomPosition(),
          iteration: 0,
        })),
      );
    }
  }, [dimensions.height, dimensions.width, randomPosition, squareCount]);

  const moveSquare = useCallback(
    (squareId) => {
      setSquares((current) =>
        current.map((square) =>
          square.id === squareId
            ? {
                ...square,
                position: randomPosition(),
                iteration: square.iteration + 1,
              }
            : square,
        ),
      );
    },
    [randomPosition],
  );

  return (
    <svg
      ref={containerRef}
      aria-hidden="true"
      role="presentation"
      focusable="false"
      className={`magic-grid-pattern ${className}`.trim()}
    >
      <defs>
        <pattern
          id={patternId}
          width={cellSize}
          height={cellSize}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M.5 ${cellSize}V.5H${cellSize}`}
            fill="none"
            stroke="currentColor"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      {squares.map(({ id, iteration, position: [x, y] }, index) => {
        const rectProps = {
          width: cellSize - 1,
          height: cellSize - 1,
          x: x * cellSize + 1,
          y: y * cellSize + 1,
          fill: "currentColor",
          strokeWidth: 0,
        };

        return reduceMotion ? (
          <rect key={id} {...rectProps} opacity="0.2" />
        ) : (
          <motion.rect
            key={`${id}-${iteration}`}
            {...rectProps}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.38 }}
            transition={{
              duration: 3,
              repeat: 1,
              delay: index * 0.08,
              repeatType: "reverse",
              repeatDelay: 0.4,
            }}
            onAnimationComplete={() => moveSquare(id)}
          />
        );
      })}
    </svg>
  );
}

export function ShineBorder({ className = "" }) {
  return (
    <div
      aria-hidden="true"
      className={`magic-shine-border ${className}`.trim()}
    />
  );
}

export function BorderBeam({
  className = "",
  size = 84,
  duration = 4,
  colorFrom = "#9b7bff",
  colorTo = "#66e4f5",
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div aria-hidden="true" className={`magic-border-beam ${className}`.trim()}>
      <motion.div
        className="magic-border-beam-light"
        style={{
          width: size,
          offsetPath: "rect(0 auto auto 0 round 24px)",
          "--beam-color-from": colorFrom,
          "--beam-color-to": colorTo,
        }}
        initial={{ offsetDistance: "0%" }}
        animate={reduceMotion ? { offsetDistance: "25%" } : {
          offsetDistance: ["0%", "100%"],
        }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { repeat: Infinity, ease: "linear", duration }
        }
      />
    </div>
  );
}
