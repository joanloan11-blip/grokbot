import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}
