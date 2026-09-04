import { useI18n, type Locale } from '../i18n';
import { selectClassName } from './ui';

export function LanguageSelect({ compact = false }: { readonly compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="inline-flex items-center">
      <span className="sr-only">{t('Language')}</span>
      <select
        aria-label={t('Language')}
        className={`${selectClassName} ${compact ? 'min-h-9 w-auto py-1.5 text-xs' : ''}`}
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        <option value="en">English</option>
        <option value="zh-CN">中文</option>
      </select>
    </label>
  );
}
