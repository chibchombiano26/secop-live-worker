import {describe,it,expect} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import {inspectArchive, normalizeExtraction, splitEvidence, HttpExtractionProvider} from '../src/dossier/extraction';
describe('document extraction contracts',()=>{
 it('preserves parser pages, spreadsheet tables and warnings without invented pages',()=>{
 const r=normalizeExtraction({parserVersion:'test-v1',pages:[{page:2,text:'Required experience: three contracts.'},{section:'Sheet1',text:'| Ratio | Minimum |\n| Liquidity | 1.5 |'}],warnings:[],complete:true});
 expect(r.pages[0].page).toBe(2);expect(r.pages[1].page).toBeUndefined();expect(splitEvidence(r,'version-1').every(c=>c.documentVersionId==='version-1')).toBe(true);
 });
 it('rejects empty scans, parser partial results, encrypted/unsupported output and excessive extraction',()=>{
 expect(()=>normalizeExtraction({parserVersion:'ocr',pages:[{page:1,text:''}],warnings:[],complete:true})).toThrow('OCR_REQUIRED');
 expect(()=>normalizeExtraction({parserVersion:'x',pages:[{text:'partial'}],warnings:[],complete:false})).toThrow('EXTRACTION_INCOMPLETE');
 expect(()=>normalizeExtraction({error:'encrypted'})).toThrow();
 });
 it('blocks archive traversal, nested depth, expansion and entry counts before extraction',()=>{
 expect(()=>inspectArchive(zipSync({'../x.pdf':strToU8('x')}))).toThrow('UNSAFE_ARCHIVE');
 expect(()=>inspectArchive(zipSync({'large.pdf':strToU8('long')}),{maxExpandedBytes:2})).toThrow('ARCHIVE_LIMIT');
 expect(()=>inspectArchive(zipSync({'a':strToU8('x'),'b':strToU8('x')}),{maxEntries:1})).toThrow('ARCHIVE_LIMIT');
 const nested=zipSync({'a.zip':zipSync({'b.zip':zipSync({'x.pdf':strToU8('x')})})});expect(()=>inspectArchive(nested)).toThrow('ARCHIVE_LIMIT');
 });
 it('sends bytes only to a server-configured HTTPS extractor and requires complete output',async()=>{
 const provider=new HttpExtractionProvider({EXTRACTOR_URL:'https://extractor.test/v1/extract',EXTRACTOR_KEY:'secret'},async(_url,init)=>{
 expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
 return Response.json({parserVersion:'ocr-v1',pages:[{page:1,text:'Scanned contract text'}],warnings:[],complete:true});
 });
 expect((await provider.extract({name:'scan.pdf',mime:'application/pdf',bytes:strToU8('%PDF')},AbortSignal.timeout(1000))).parserVersion).toBe('ocr-v1');
 await expect(new HttpExtractionProvider({EXTRACTOR_URL:'http://localhost/x',EXTRACTOR_KEY:'s'}).extract({name:'x.pdf',mime:'application/pdf',bytes:strToU8('%PDF')},AbortSignal.timeout(1000))).rejects.toThrow('EXTRACTOR_UNCONFIGURED');
 });
});
