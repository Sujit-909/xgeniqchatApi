'use client';
import { useEffect, useRef } from 'react';

export default function Video({ stream, muted = false, mirror = false, className = '' }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream || null; }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={`${className} ${mirror ? 'mirror' : ''}`} />;
}
