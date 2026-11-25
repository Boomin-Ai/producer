import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import LightRays from './LightRays';
import ShinyText from './ShinyText';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function StudioLight() {
  const [moving, setMoving] = useState(true);

  useEffect(() => {
    const stop = setTimeout(() => setMoving(false), 4500);
    return () => clearTimeout(stop);
  }, []);

  return (
    <LightRays
      raysOrigin="top-center"
      raysColor="#a5b4fe"
      raysSpeed={moving ? 0.66 : 0}
      lightSpread={0.7}
      rayLength={2.05}
      rayDensity={1.52}
      raySharpness={0.48}
      fadeDistance={1.24}
      glow={0.42}
      haze={0.16}
      intensity={0.83}
      atmosphere={0.42}
      opacity={0.62}
      maxDevicePixelRatio={0.82}
      followMouse={false}
      cursorShadow={false}
      clickPulse={false}
    />
  );
}

const light = document.getElementById('hero-rays');
const headline = document.getElementById('hero-shine');
const tagline = headline.textContent;
let lightsRoot;
let textRoot;

function applyMotionPreference() {
  if (reduceMotion.matches) {
    lightsRoot?.unmount();
    lightsRoot = null;
    textRoot?.unmount();
    textRoot = null;
    headline.textContent = tagline;
    return;
  }

  if (!lightsRoot) {
    lightsRoot = createRoot(light);
    lightsRoot.render(<StudioLight />);
  }
  if (!textRoot) {
    textRoot = createRoot(headline);
    textRoot.render(
      <ShinyText
        text={tagline}
        color="#dce4f4"
        shineColor="#fff"
        direction="right"
        trigger="view"
        speed={2.2}
        angle={108}
        shineWidth={26}
        softness={0.92}
      />
    );
  }
}

applyMotionPreference();
reduceMotion.addEventListener('change', applyMotionPreference);
