/**
 * Lite PRD parser — extracts features, modules, and data models
 * from plain-text or markdown PRD documents.
 */
export class PrdParser {
  constructor(content) {
    this.content = content;
  }

  parse() {
    const lines = this.content.split('\n');
    const features = [];
    const modules = [];
    const dataModels = [];
    let currentSection = null;

    const sectionPatterns = [
      { re: /(?:feature|functionality|capabilities)/i, name: 'features' },
      { re: /(?:module|component|page|screen)/i, name: 'modules' },
      { re: /(?:data model|schema|database|entity|table)/i, name: 'dataModels' },
      { re: /(?:requirement|prd)/i, name: 'requirements' },
    ];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Detect section headers
      const isHeader = /^#{1,4}\s/.test(trimmed) || /^[A-Z][A-Z\s]+$/.test(trimmed) || /^-\s*\[.*\]/.test(trimmed);
      if (isHeader) {
        for (const sp of sectionPatterns) {
          if (sp.re.test(trimmed)) {
            currentSection = sp.name;
            break;
          }
        }
        // Check for feature list items
        const featureMatch = trimmed.match(/^[-*]\s*(.+)/);
        if (featureMatch && !currentSection) {
          features.push({ name: featureMatch[1], description: '', source: 'header' });
        }
        continue;
      }

      // Bullet items
      const bulletMatch = trimmed.match(/^[-*\d.]+(?:\.)?\s+(.+)/);
      if (bulletMatch) {
        const text = bulletMatch[1];
        const name = text.split(/[,:]/)[0].trim();
        const description = text;

        switch (currentSection) {
          case 'features':
            features.push({ name, description, source: 'bullet' });
            break;
          case 'modules':
            modules.push({ name, description, source: 'bullet' });
            break;
          case 'dataModels':
            dataModels.push({ name, description, source: 'bullet' });
            break;
          default:
            // Heuristically detect
            if (/\.(ts|js|jsx|tsx|vue|py|go|rs)$/i.test(name)) {
              modules.push({ name, description, source: 'heuristic' });
            } else if (/(model|schema|entity|table|db|database)/i.test(description)) {
              dataModels.push({ name, description, source: 'heuristic' });
            } else {
              features.push({ name, description, source: 'heuristic' });
            }
        }
        continue;
      }

      // Plain text line — might be a feature description
      if (currentSection === 'features' && trimmed.length > 10) {
        if (features.length > 0) {
          const last = features[features.length - 1];
          if (last.description === '') last.description = trimmed;
        }
      }
    }

    return {
      title: this._inferTitle(),
      features,
      modules,
      dataModels,
      raw: this.content
    };
  }

  _inferTitle() {
    const lines = this.content.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (/^#\s+(.+)/.test(t)) return t.replace(/^#\s+/, '');
    }
    for (const line of lines) {
      const t = line.trim();
      if (t.length > 5 && t.length < 100 && !t.startsWith('-') && !t.startsWith('*')) return t;
    }
    return 'Untitled PRD';
  }
}
