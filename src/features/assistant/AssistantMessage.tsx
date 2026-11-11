import {Fragment, type ReactNode} from 'react';

// A deliberately small display grammar. React owns every node: model output
// cannot inject HTML, load remote images or create executable links.
function inline(text:string):ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part,index)=>part.startsWith('`')&&part.endsWith('`')?<code key={index}>{part.slice(1,-1)}</code>:part.startsWith('**')&&part.endsWith('**')?<strong key={index}>{part.slice(2,-2)}</strong>:<Fragment key={index}>{part}</Fragment>);
}
const cells=(line:string)=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());
const divider=(line:string)=>{const row=cells(line);return row.length>1&&row.every(cell=>/^:?-{3,}:?$/.test(cell));};
export function AssistantMessage({text}:{text:string}) {
  const lines=text.split('\n'),blocks:ReactNode[]=[];
  for(let index=0;index<lines.length;){
    const line=lines[index];
    if(!line.trim()){index++;continue;}
    if(line.trim().startsWith('```')){
      const code:string[]=[];index++;
      while(index<lines.length&&!lines[index].trim().startsWith('```'))code.push(lines[index++]);
      index++;blocks.push(<pre key={blocks.length}><code>{code.join('\n')}</code></pre>);continue;
    }
    if(index+1<lines.length&&line.includes('|')&&divider(lines[index+1])){
      const head=cells(line),rows:string[][]=[];index+=2;
      while(index<lines.length&&lines[index].trim()&&lines[index].includes('|'))rows.push(cells(lines[index++]));
      blocks.push(<div className="assistant-table" key={blocks.length} tabIndex={0} role="region" aria-label="Response table"><table><thead><tr>{head.map((cell,i)=><th key={i}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row,r)=><tr key={r}>{row.map((cell,c)=><td key={c}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);continue;
    }
    if(/^\s*[-*] /.test(line)||/^\s*\d+\. /.test(line)){
      const ordered=/^\s*\d+\. /.test(line),items:string[]=[];
      const pattern=ordered?/^\s*\d+\. /:/^\s*[-*] /;
      while(index<lines.length&&pattern.test(lines[index]))items.push(lines[index++].replace(pattern,''));
      const children=items.map((item,i)=><li key={i}>{inline(item)}</li>);
      blocks.push(ordered?<ol key={blocks.length}>{children}</ol>:<ul key={blocks.length}>{children}</ul>);continue;
    }
    if(/^#{1,6} /.test(line)){blocks.push(<h4 key={blocks.length}>{inline(line.replace(/^#{1,6} /,''))}</h4>);index++;continue;}
    const paragraph=[line];index++;
    while(index<lines.length&&lines[index].trim()&&!/^\s*(?:```|#{1,6} |[-*] |\d+\. )/.test(lines[index])&&!(index+1<lines.length&&lines[index].includes('|')&&divider(lines[index+1])))paragraph.push(lines[index++]);
    blocks.push(<p key={blocks.length}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="assistant-rich-text">{blocks}</div>;
}
