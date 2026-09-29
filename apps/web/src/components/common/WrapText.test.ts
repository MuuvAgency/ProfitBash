import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { h } from 'vue';
import WrapText from './WrapText.vue';

/** Knoten im umschließenden Element (die Komponente rendert ein Fragment). */
function nodes(text: string) {
  const wrapper = mount({ render: () => h('p', [h(WrapText, { text })]) });
  return [...wrapper.element.childNodes]
    .filter(
      (node) =>
        node.nodeType === Node.ELEMENT_NODE ||
        (node.nodeType === Node.TEXT_NODE && node.textContent !== ''),
    )
    .map((node) => (node.nodeType === Node.TEXT_NODE ? node.textContent : `<${node.nodeName}>`));
}

describe('WrapText', () => {
  it('setzt Umbruchstellen nach „@“ und „/“, der Text bleibt gleich', () => {
    expect(nodes('amazon-ads@kunde.test/Europe/Berlin')).toEqual([
      'amazon-ads@',
      '<WBR>',
      'kunde.test/',
      '<WBR>',
      'Europe/',
      '<WBR>',
      'Berlin',
    ]);
  });

  it('lässt Text ohne diese Zeichen unverändert', () => {
    expect(nodes('EZB, für alle')).toEqual(['EZB, für alle']);
  });
});
