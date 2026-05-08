/**
 * App Guide Loader
 *
 * Loads community-contributed application guides from the guides/ directory.
 * Guides teach the AI how to efficiently operate specific apps — workflows,
 * keyboard shortcuts, UI layout, and tips.
 *
 * Guides are JSON files named {process-name}.json and loaded automatically
 * when the target app is detected. No code changes needed to add new guides.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AppGuide {
  app: string;
  processNames: string[];
  workflows: Record<string, string>;
  shortcuts: Record<string, string>;
  layout: Record<string, string>;
  tips: string[];
}

// Cache loaded guides to avoid re-reading files
const guideCache = new Map<string, AppGuide | null>();
const processToGuide = new Map<string, string>(); // process name → guide file name
let indexBuilt = false;

/**
 * Build an index of process names → guide files (done once).
 */
function buildIndex(): void {
  if (indexBuilt) return;
  indexBuilt = true;

  const guidesDir = path.join(__dirname, '..', 'guides');
  if (!fs.existsSync(guidesDir)) return;

  try {
    const files = fs.readdirSync(guidesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(guidesDir, file), 'utf8');
        const guide: AppGuide = JSON.parse(content);
        const baseName = file.replace('.json', '');
        guideCache.set(baseName, guide);

        // Map all process names to this guide
        for (const pn of guide.processNames || []) {
          processToGuide.set(pn.toLowerCase(), baseName);
        }
      } catch {
        // Skip malformed guides silently
      }
    }
  } catch {
    // guides dir unreadable
  }
}

/**
 * Load a guide for the given process name. Returns null if no guide exists.
 */
export function loadGuide(processName: string): AppGuide | null {
  buildIndex();

  const normalized = processName.toLowerCase();

  // Direct match on process name
  const guideName = processToGuide.get(normalized);
  if (guideName && guideCache.has(guideName)) {
    return guideCache.get(guideName) || null;
  }

  // Try loading by filename
  if (guideCache.has(normalized)) {
    return guideCache.get(normalized) || null;
  }

  return null;
}

/**
 * Format a guide as concise text for injection into the LLM system prompt.
 * Keeps it compact to minimize token usage.
 */
export function formatGuideForPrompt(guide: AppGuide): string {
  const lines: string[] = [];
  lines.push(`\n--- APP GUIDE: ${guide.app} ---`);

  // Workflows (most important — hand-crafted)
  if (guide.workflows && Object.keys(guide.workflows).length > 0) {
    lines.push('WORKFLOWS:');
    for (const [name, steps] of Object.entries(guide.workflows)) {
      lines.push(`  ${name}: ${steps}`);
    }
  }

  // Learned workflows (auto-discovered from previous successful tasks)
  const learned = (guide as any).learnedWorkflows;
  if (learned && Object.keys(learned).length > 0) {
    lines.push('LEARNED WORKFLOWS (from previous successes):');
    for (const [name, steps] of Object.entries(learned)) {
      lines.push(`  ${name}: ${steps}`);
    }
  }

  // Key shortcuts
  if (guide.shortcuts && Object.keys(guide.shortcuts).length > 0) {
    const shortcutStr = Object.entries(guide.shortcuts)
      .map(([name, key]) => `${name}=${key}`)
      .join(', ');
    lines.push(`SHORTCUTS: ${shortcutStr}`);
  }

  // Layout
  if (guide.layout && Object.keys(guide.layout).length > 0) {
    lines.push('LAYOUT:');
    for (const [area, desc] of Object.entries(guide.layout)) {
      lines.push(`  ${area}: ${desc}`);
    }
  }

  // Tips
  if (guide.tips && guide.tips.length > 0) {
    lines.push('IMPORTANT TIPS:');
    for (const tip of guide.tips) {
      lines.push(`  - ${tip}`);
    }
  }

  lines.push('--- END GUIDE ---\n');
  return lines.join('\n');
}

/**
 * Get formatted guide text for a process name, ready for prompt injection.
 * Returns empty string if no guide found.
 */
export function getGuidePrompt(processName: string): string {
  const guide = loadGuide(processName);
  if (!guide) return '';
  return formatGuideForPrompt(guide);
}

/**
 * Save a learned workflow to the app's guide JSON.
 * Called after a task succeeds — extracts the action sequence and saves it
 * so next time the same task type executes faster.
 *
 * This is the adaptive learning loop:
 *   Task succeeds → extract action pattern → save to guide → next time reads guide → faster
 */
export function saveLesson(
  processName: string,
  taskDescription: string,
  actionLog: Array<{ action: string; description: string }>,
): void {
  if (!processName || actionLog.length === 0) return;

  const guide = loadGuide(processName);
  const guidesDir = path.join(__dirname, '..', 'guides');

  // Create a workflow key from the task (kebab-case, max 40 chars)
  const workflowKey = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 40);

  // Build workflow string from successful action sequence
  const workflowSteps = actionLog
    .filter(a => a.action !== 'done' && a.action !== 'done_rejected' && a.action !== 'blocked' && a.action !== 'parse_error')
    .map(a => {
      if (a.action === 'key') return `Press ${a.description.split(': ').pop()}`;
      if (a.action === 'click') return `Click ${a.description}`;
      if (a.action === 'type') return `Type text`;
      if (a.action === 'a11y_click') return `Click "${a.description.split('"')[1] || 'element'}"`;
      if (a.action === 'drag') return `Drag ${a.description}`;
      if (a.action === 'scroll') return `Scroll ${a.description}`;
      return a.description;
    })
    .join('. ');

  if (!workflowSteps) return;

  try {
    if (guide) {
      // Update existing guide with new workflow
      const guidePath = path.join(guidesDir, (guide.processNames?.[0] || processName) + '.json');
      if (!fs.existsSync(guidePath)) return;

      const raw = JSON.parse(fs.readFileSync(guidePath, 'utf8'));
      if (!raw.workflows) raw.workflows = {};
      if (!raw.learnedWorkflows) raw.learnedWorkflows = {};

      // Save under learnedWorkflows (separate from hand-crafted ones)
      raw.learnedWorkflows[workflowKey] = workflowSteps;

      // Cap at 20 learned workflows per app (FIFO)
      const keys = Object.keys(raw.learnedWorkflows);
      if (keys.length > 20) {
        delete raw.learnedWorkflows[keys[0]];
      }

      fs.writeFileSync(guidePath, JSON.stringify(raw, null, 2));
      console.log(`   [LEARN] 📝 Saved workflow "${workflowKey}" to ${path.basename(guidePath)}`);
    } else {
      // Create a new guide for this app
      if (!fs.existsSync(guidesDir)) fs.mkdirSync(guidesDir, { recursive: true });
      const newGuide = {
        app: processName,
        processNames: [processName],
        shortcuts: {},
        learnedWorkflows: { [workflowKey]: workflowSteps },
        tips: [`Auto-learned from successful task: ${taskDescription}`],
      };
      const guidePath = path.join(guidesDir, processName + '.json');
      fs.writeFileSync(guidePath, JSON.stringify(newGuide, null, 2));
      console.log(`   [LEARN] 📝 Created new guide for "${processName}" with workflow "${workflowKey}"`);
      // Invalidate cache so the new guide loads next time
      indexBuilt = false;
    }
  } catch (err) {
    // Non-fatal — learning is best-effort
    console.warn(`   [LEARN] ⚠️ Failed to save lesson: ${err}`);
  }
}
