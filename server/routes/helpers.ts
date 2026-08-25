export function getPresentationMonth(reportMonth: string): string {
  const [year, month] = reportMonth.split('-').map(Number);
  const nextMonth = month + 1;
  if (nextMonth > 12) {
    return `${year + 1}-01`;
  }
  return `${year}-${nextMonth.toString().padStart(2, '0')}`;
}

export function classifyPhases(values: number[]): string[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return ["Hold"];
  
  const indexed = values.map((v, i) => ({ value: v, originalIndex: i }));
  
  const sorted = [...indexed].sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    return a.originalIndex - b.originalIndex;
  });
  
  const rankMap = new Map<number, number>();
  sorted.forEach((item, rank) => {
    rankMap.set(item.originalIndex, rank);
  });
  
  if (n <= 6) {
    return values.map((_, i) => {
      const rank = rankMap.get(i)!;
      if (rank === 0) return "Peak";
      if (rank === n - 1) return "Soft";
      if (n === 2) return rank === 0 ? "Peak" : "Soft";
      if (n === 3) return rank === 1 ? "Hold" : (rank === 0 ? "Peak" : "Soft");
      if (rank <= 1) return "Hold";
      if (rank >= n - 2) return "Rebuild";
      return "Taper";
    });
  }
  
  const peakCutoff = Math.max(1, Math.min(2, Math.ceil(n * 0.12)));
  const holdCutoff = Math.max(peakCutoff + 1, Math.ceil(n * 0.30));
  const softCutoff = Math.min(n - 1, Math.max(holdCutoff + 1, Math.floor(n * 0.75)));
  
  const peakThreshold = sorted[peakCutoff - 1].value;
  const holdThreshold = sorted[holdCutoff - 1].value;
  const softThreshold = sorted[softCutoff - 1].value;
  
  function getMultiMonthMomentum(index: number): number {
    const prev1 = values[(index - 1 + n) % n];
    const prev2 = values[(index - 2 + n) % n];
    const current = values[index];
    return (current - prev1) * 0.6 + (prev1 - prev2) * 0.4;
  }
  
  function isNearLowPoint(index: number): boolean {
    for (let offset = -3; offset <= 0; offset++) {
      const checkIdx = (index + offset + n) % n;
      if (values[checkIdx] <= softThreshold) return true;
    }
    return false;
  }
  
  function isRisingTowardPeak(index: number): boolean {
    for (let offset = 1; offset <= 3; offset++) {
      const checkIdx = (index + offset) % n;
      if (values[checkIdx] >= holdThreshold) return true;
    }
    return false;
  }
  
  const initialPhases: string[] = [];
  for (let i = 0; i < n; i++) {
    const value = values[i];
    const momentum = getMultiMonthMomentum(i);
    
    if (value >= peakThreshold) {
      initialPhases.push("Peak");
    } else if (value >= holdThreshold) {
      initialPhases.push(momentum < -3 ? "Taper" : "Hold");
    } else if (value <= softThreshold) {
      initialPhases.push(momentum > 1 ? "Rebuild" : "Soft");
    } else {
      const nearLow = isNearLowPoint(i);
      const risingToPeak = isRisingTowardPeak(i);
      
      if (nearLow && risingToPeak) {
        initialPhases.push("Rebuild");
      } else if (momentum > 1 || (nearLow && momentum >= 0)) {
        initialPhases.push("Rebuild");
      } else if (momentum < -2) {
        initialPhases.push("Taper");
      } else if (!nearLow && momentum < 0) {
        initialPhases.push("Taper");
      } else {
        initialPhases.push("Hold");
      }
    }
  }
  
  const phases: string[] = [...initialPhases];
  const validTransitions: Record<string, string[]> = {
    "Peak": ["Peak", "Hold", "Taper"],
    "Hold": ["Peak", "Hold", "Taper", "Soft"],
    "Taper": ["Peak", "Hold", "Taper", "Soft"],
    "Soft": ["Peak", "Soft", "Rebuild", "Hold"],
    "Rebuild": ["Rebuild", "Hold", "Peak", "Soft"],
  };
  
  function fixTransition(prevPhase: string, currentPhase: string, momentum: number): string {
    const allowed = validTransitions[prevPhase] || [];
    if (allowed.includes(currentPhase)) return currentPhase;
    
    if (prevPhase === "Soft" && currentPhase === "Taper") {
      return momentum > 0 ? "Rebuild" : "Soft";
    } else if (prevPhase === "Peak" && currentPhase === "Soft") {
      return "Taper";
    } else if (prevPhase === "Rebuild" && currentPhase === "Taper") {
      return momentum > 0 ? "Rebuild" : "Hold";
    } else if (prevPhase === "Rebuild" && currentPhase === "Soft") {
      return "Rebuild";
    }
    return allowed[0] || currentPhase;
  }
  
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    
    for (let i = 0; i < n; i++) {
      const prevIdx = (i - 1 + n) % n;
      const prevPhase = phases[prevIdx];
      const currentPhase = phases[i];
      const momentum = getMultiMonthMomentum(i);
      const fixed = fixTransition(prevPhase, currentPhase, momentum);
      if (fixed !== phases[i]) {
        phases[i] = fixed;
        changed = true;
      }
    }
    
    if (!changed) break;
  }
  
  return phases;
}
