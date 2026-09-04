// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanguageSelect } from './components/language-select';
import { I18nProvider, translate, useI18n } from './i18n';

function Probe() {
  const { locale, t } = useI18n();
  return (
    <>
      <LanguageSelect />
      <p>{t('Signed in as {{name}}', { name: 'admin' })}</p>
      <output aria-label="Current locale">{locale}</output>
    </>
  );
}

describe('web internationalization', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      value: ['en-US'],
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.lang = '';
  });

  it('falls back to the English source and interpolates named values', () => {
    expect(translate('en', 'Signed in as {{name}}', { name: 'admin' })).toBe(
      'Signed in as admin',
    );
    expect(translate('zh-CN', 'Signed in as {{name}}', { name: 'admin' })).toBe(
      '已以 admin 身份登录',
    );
    expect(translate('zh-CN', 'Untranslated provider value')).toBe(
      'Untranslated provider value',
    );
  });

  it('switches language immediately and persists the preference', async () => {
    const user = userEvent.setup();
    const first = render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByText('Signed in as admin')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Language'), 'zh-CN');

    expect(screen.getByText('已以 admin 身份登录')).toBeTruthy();
    expect(screen.getByLabelText('Current locale').textContent).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(window.localStorage.getItem('openpool.locale')).toBe('zh-CN');

    first.unmount();
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('已以 admin 身份登录')).toBeTruthy();
  });

  it('uses the browser language when no preference was saved', () => {
    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      value: ['zh-CN', 'en-US'],
    });
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('已以 admin 身份登录')).toBeTruthy();
  });
});
