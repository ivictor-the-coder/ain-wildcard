/**
 * "What can I ask?" — the whitelist, as things a person can press.
 *
 * Both components below take their data as props and use no hooks, so they can
 * be rendered to markup in a test and walked for the button that asks. The
 * fetch (`useTemplates` in `api.ts`) and the modal around the panel live with
 * the page.
 */
import { Icons } from '@/client/design';
import type { AiTemplate, TemplateGroup } from './templates-core';

/** The full list, grouped, with the example wording as the thing to press. */
export function TemplatePanel({ groups, onAsk, query, total }: {
  groups: TemplateGroup[];
  onAsk: (question: string) => void;
  /** The filter typed above the panel, so the empty state can quote it. */
  query?: string;
  /** How many shapes there are before the filter, for the same empty state. */
  total?: number;
}) {
  if (!groups.length) {
    return (
      <p className="cp-templates__empty" role="status">
        {query
          ? `None of the ${total ?? 0} shapes mention “${query}”. Try a shorter word — “deals”, “owed”, “Growth”.`
          : 'This workspace publishes no question shapes yet, so there is nothing to pick from.'}
      </p>
    );
  }
  return (
    <div className="cp-templates">
      {groups.map((group) => (
        <section className="cp-templates__group" key={group.id} aria-labelledby={`cp-tg-${group.id}`}>
          <h3 className="cp-templates__title" id={`cp-tg-${group.id}`}>
            {group.label}
            <span className="cp-templates__count">{group.templates.length}</span>
          </h3>
          {group.blurb && <p className="cp-templates__blurb">{group.blurb}</p>}
          <ul className="cp-templates__list">
            {group.templates.map((template) => (
              <li key={template.id}>
                <button
                  type="button"
                  className="cp-template"
                  data-template-id={template.id}
                  title={template.shape}
                  onClick={() => onAsk(template.example)}
                >
                  <span className="cp-template__q">{template.example}</span>
                  {template.description && <span className="cp-template__why">{template.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The five that open an empty thread.
 *
 * Drawn as the same cards the old starter prompts were, because they are what
 * those prompts should always have been: questions the engine is certain to
 * answer, in the workspace's own values.
 */
export function TemplateStarters({ templates, onAsk, onSeeAll, total }: {
  templates: AiTemplate[];
  onAsk: (question: string) => void;
  onSeeAll: () => void;
  total: number;
}) {
  return (
    <div className="cp-starters">
      <div className="cp-suggest">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            className="cp-suggest__item"
            data-template-id={template.id}
            title={template.shape}
            onClick={() => onAsk(template.example)}
          >
            <span className="cp-suggest__q">{template.example}</span>
            <span className="cp-suggest__why">{template.description}</span>
          </button>
        ))}
      </div>
      {total > templates.length && (
        <button type="button" className="cp-help__more" onClick={onSeeAll}>
          <Icons.list size={12} />
          See all {total} questions it can answer
        </button>
      )}
    </div>
  );
}
