/**
 * Slide — shared pieces of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 528–627 @ d31d7c0c7, Task #4271).
 * Zero visual/behavioral change intended — do not edit alongside a move.
 */

import { useState, useRef, useEffect, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { motion, Variants, useInView, useReducedMotion } from "framer-motion";

export interface SlideProps {
  children: ReactNode;
  slideNumber?: number;
  variant?: 'burgundy' | 'beige' | 'charcoal' | 'cream';
  pattern?: 'geometric' | 'dots' | 'lines' | 'none';
  showFrame?: boolean;
  id?: string;
  /** Vertically center short content in the 100vh slide (§8.4 dead-space fix, Task #4275). */
  vCenter?: boolean;
  /** The deck's final slide — suppresses the scroll-down cue (Task #4284). */
  isLastSlide?: boolean;
}

export function Slide({ children, slideNumber, variant = 'beige', pattern = 'none', showFrame = true, id, vCenter = false, isLastSlide = false }: SlideProps) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: false, margin: "-40% 0px -40% 0px" });
  // OS-level reduced motion: skip the scroll-linked reveal entirely so slides
  // are never parked at opacity 0 waiting for an entrance animation.
  const prefersReducedMotion = useReducedMotion();
  
  // Detect print mode to force visibility (animations don't work in print)
  const [isPrinting, setIsPrinting] = useState(false);
  
  useEffect(() => {
    const handleBeforePrint = () => setIsPrinting(true);
    const handleAfterPrint = () => setIsPrinting(false);
    
    // Also check if already in print mode via media query
    const printMedia = window.matchMedia('print');
    setIsPrinting(printMedia.matches);
    
    window.addEventListener('beforeprint', handleBeforePrint);
    window.addEventListener('afterprint', handleAfterPrint);
    printMedia.addEventListener('change', (e) => setIsPrinting(e.matches));
    
    return () => {
      window.removeEventListener('beforeprint', handleBeforePrint);
      window.removeEventListener('afterprint', handleAfterPrint);
    };
  }, []);

  const slideVariants: Variants = {
    hidden: { opacity: 0, y: 60 },
    visible: { 
      opacity: 1, 
      y: 0,
      transition: { duration: 0.8, ease: [0.25, 0.46, 0.45, 0.94] }
    }
  };

  const getVariantClass = () => {
    switch(variant) {
      case 'burgundy': return 'slide-burgundy';
      case 'charcoal': return 'slide-charcoal';
      case 'cream': return 'slide-cream';
      default: return 'slide-beige';
    }
  };

  const getPatternClass = () => {
    switch(pattern) {
      case 'geometric': return 'pattern-geometric';
      case 'dots': return 'pattern-dots';
      case 'lines': return 'pattern-lines';
      default: return '';
    }
  };

  return (
    <section 
      ref={ref}
      id={id}
      className={`slide ${getVariantClass()}${vCenter ? ' slide-vcenter' : ''} relative overflow-hidden`}
    >
      {pattern !== 'none' && (
        <div className={`absolute inset-0 ${getPatternClass()} pointer-events-none`} />
      )}
      
      {slideNumber && (
        <div className="slide-number">{slideNumber}</div>
      )}

      <motion.div
        initial={isPrinting || prefersReducedMotion ? "visible" : "hidden"}
        animate={isPrinting || prefersReducedMotion || isInView ? "visible" : "hidden"}
        variants={slideVariants}
        className={`relative z-10 ${showFrame ? 'slide-frame' : 'px-12 py-16'}`}
        style={isPrinting ? { opacity: 1, transform: 'none' } : undefined}
      >
        {children}
      </motion.div>

      {/* Scroll cue on every numbered slide except the deck's last (the
          book-promo colophon). Was `slideNumber < 10`, which silently
          dropped the cue from slides 10+ as the deck grew — numbering
          drift the footer normalization removes (Task #4284). */}
      {!!slideNumber && !isLastSlide && (
        <motion.div 
          className="absolute bottom-8 left-1/2 -translate-x-1/2 print:hidden"
          animate={prefersReducedMotion ? undefined : { y: [0, 8, 0] }}
          transition={prefersReducedMotion ? undefined : { repeat: Infinity, duration: 2 }}
        >
          <ChevronDown className={`w-6 h-6 ${variant === 'burgundy' || variant === 'charcoal' ? 'text-white/40' : 'text-report-crimson/40'}`} />
        </motion.div>
      )}
    </section>
  );
}
