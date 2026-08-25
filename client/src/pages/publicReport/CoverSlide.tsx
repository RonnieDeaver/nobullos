/**
 * CoverSlide — one slide of the public client report.
 * Extracted verbatim in Task #4271; restructured in Task #4275 (audit
 * §8.7-1): the logo moved into the centered flow (it clipped under the
 * sticky bar top-right), the title block vertically centers via flex-1
 * (the bottom half was dead space), and the decorative blur circles are
 * clipped so they can't widen the slide's scrollable area.
 */

import { ChevronDown } from "lucide-react";
import { motion } from "framer-motion";
import { EditableText } from "./chrome";
import { REPORT_COLORS } from "./reportTokens";
import type { PublicReportViewModel } from "./derive";

export function CoverSlide({ view }: { view: PublicReportViewModel }) {
  const { client, data, isEditing, monthLabel, prefersReducedMotion, t } = view;
  return (
        <section id="cover" className="slide relative overflow-hidden" style={{ 
          background: `linear-gradient(135deg, ${REPORT_COLORS.crimson} 0%, ${REPORT_COLORS.crimsonDeep} 40%, ${REPORT_COLORS.crimsonShadow} 100%)` 
        }}>
          {/* Decorative Elements — overflow-hidden so the translated blur
              circles never widen the slide's scrollable area (the audit
              measured scrollWidth 1640 @ a 1440 viewport; §8.7-1) */}
          <div className="absolute inset-0 opacity-10 overflow-hidden">
            <div className="absolute top-0 right-0 w-[600px] h-[600px] rounded-full bg-white/20 blur-3xl -translate-y-1/2 translate-x-1/3" />
            <div className="absolute bottom-0 left-0 w-[400px] h-[400px] rounded-full bg-black/20 blur-3xl translate-y-1/2 -translate-x-1/3" />
          </div>
          
          {/* Geometric Pattern */}
          <div className="absolute inset-0 opacity-5" style={{ 
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")` 
          }} />

          {/* Gold corner accents */}
          <div className="absolute top-6 left-6 w-20 h-20 border-t-4 border-l-4 border-report-gold/60" />
          <div className="absolute bottom-6 right-6 w-20 h-20 border-b-4 border-r-4 border-report-gold/60" />
          
          <div className="relative z-10 flex-1 px-16 py-20 text-white flex flex-col justify-center items-center text-center">
            {/* NoBull letterhead — in the centered flow so it can never clip
                under the top bar at any width (§8.7-1 header stacking,
                Task #4275). print:hidden keeps the print cover exactly as
                before (print already hid the old absolute-positioned logo). */}
            <motion.div 
              initial={prefersReducedMotion ? {} : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8 }}
              className="mb-10 print:hidden"
            >
              <img 
                src="/assets/NoBull.Primary.Logo.White_1768864291629.png" 
                alt="NoBull Marketing" 
                className="h-9 md:h-10 w-auto"
              />
            </motion.div>

            {/* Main Title - Center */}
            <motion.div
              initial={prefersReducedMotion ? {} : { opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.2 }}
            >
              <h1 className="report-display mb-4">
                Revenue Engine<br />
                <span className="text-report-gold">Report</span>
              </h1>
            </motion.div>
            
            {/* Client Name + Report Period */}
            <motion.div 
              initial={prefersReducedMotion ? {} : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.5 }}
              className="mb-6"
            >
              <div className="text-xl text-white/80 font-report-serif">
                <EditableText value={client.firmName} isEditing={isEditing} />
              </div>
              <div className="text-sm text-report-gold/80 uppercase tracking-[0.15em] mt-1">
                {monthLabel} Report
              </div>
            </motion.div>
            
            {/* Divider Line */}
            <motion.div 
              initial={prefersReducedMotion ? {} : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.8, delay: 0.6 }}
              className="w-20 h-0.5 bg-report-gold rounded-full mb-6"
            />
            
            {/* Value Statement - Bottom */}
            <motion.p 
              initial={prefersReducedMotion ? {} : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.8 }}
              className="text-lg text-white/60 max-w-lg leading-relaxed"
            >
              A data-driven analysis of your Marketing, Intake & Sales performance — with clear next steps.
            </motion.p>
          </div>
          
          {/* Bottom Bar */}
          <div className="absolute bottom-0 left-0 right-0 px-16 py-6 flex justify-between items-center border-t border-report-gold/20 bg-black/20 backdrop-blur-sm print:hidden">
            <div className="text-white/70 text-xs uppercase tracking-widest font-medium">nobullmarketing.com</div>
            {/* Full-opacity gold: /60 composited to ~3:1 on the bar over the
                crimson gradient; full gold is ~5.2:1 vs the worst case
                (crimson #8A292F under bg-black/20) — AA for the 12px label.
                Same treatment as the white/70 footer bump (Task #4709). */}
            <div className="text-report-gold text-xs uppercase tracking-widest font-medium">
              {monthLabel}
            </div>
          </div>

          {/* Scroll indicator */}
          <motion.div 
            className="absolute bottom-16 left-1/2 -translate-x-1/2 print:hidden"
            animate={prefersReducedMotion ? undefined : { y: [0, 8, 0] }}
            transition={prefersReducedMotion ? undefined : { repeat: Infinity, duration: 2 }}
          >
            <ChevronDown className="w-6 h-6 text-white/40" />
          </motion.div>
        </section>
  );
}
