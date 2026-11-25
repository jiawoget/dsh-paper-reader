import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { assertContrast } from './helpers/contrast.js';
import { assertMobilePanelTargets, blockClipboard, restoreClipboard } from './helpers/dom-probes.js';
import { readDownload } from './helpers/reader.js';
import { withHost } from './host.js';
import type { NotebookSnapshot, Operations } from '../../src/shared/types.js';

await withHost(async ({origin, authenticatedUrl, executable}) => {
  const browser=await chromium.launch({executablePath:executable});
  try {
    const ctx=await browser.newContext({locale:'en-US',viewport:{width:1440,height:900}});
    const page=await ctx.newPage(), errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    const appUrl=origin+'/api/paper-reader/app/index.html?doc=pagedattention&page=6';
    await page.goto(authenticatedUrl); await page.goto(appUrl);
    const loaded=(p:Page)=>p.locator('#loading').waitFor({state:'hidden'});
    const go=async(n:number)=>{await page.locator('#pageCount').click();await page.locator('#pageNumber').fill(String(n));await page.locator('#pageNumber').press('Enter');await page.waitForURL(url=>url.searchParams.get('page')===String(n));await loaded(page);};
    const action=async<K extends keyof Operations>(op:K,payload:Operations[K][0]):Promise<Operations[K][1]>=>{
      const res=await page.request.post(origin+'/api/paper-reader/action',{data:{op,payload}});
      assert.ok(res.ok(),op+' '+res.status());return res.json();
    };
    const marks=async()=>(await action('annotation.list',{docId:'pagedattention'})).annotations;
    const book=():Promise<NotebookSnapshot>=>action('notebook.get',{docId:'pagedattention',title:'PagedAttention.pdf',sourceUrl:appUrl});
    const screenshots=process.env.PAPER_READER_ANNOTATION_ARTIFACTS;
    if(screenshots)await mkdir(screenshots,{recursive:true});
    const capture=async(name:string)=>{if(screenshots)await page.screenshot({path:path.join(screenshots,name+'.png')});};
    await loaded(page);const initialBook=await book();
    const run=page.locator('#original .pdf-native-text [data-block-id="block-tables"]').filter({hasText:/mapping between logical/i}).first();
    await run.evaluate(e=>{
      const text=e.firstChild as Text;
      const candidates=[...document.querySelectorAll('#original .pdf-native-text [data-block-id="block-tables"]')];
      const last=candidates.slice(candidates.indexOf(e)).find(node=>node.textContent?.includes('each request'))?.firstChild as Text;
      if(!last||text.data.indexOf('the mapping')<0)throw Error('Missing the block table mapping in the real PDF');
      document.getSelection()!.setBaseAndExtent(text,text.data.indexOf('the mapping'),last,last.data.indexOf('each request')+'each request'.length);
      e.dispatchEvent(new KeyboardEvent('keyup',{key:'Shift',bubbles:true}));
    });
    await page.getByRole('button',{name:'Highlight',exact:true}).click();
    const highlight=page.locator('#original .annotation-highlight').first();
    await highlight.waitFor({state:'attached'});
    assert.equal((await book()).markdown,initialBook.markdown);
    assert.equal((await marks()).length,1);

    const selectPhrase = async (blockId: string, match: RegExp) => {
      const el = page.locator(`#original .pdf-native-text [data-block-id="${blockId}"]`).filter({ hasText: match }).first();
      await el.evaluate(node => {
        const text = node.firstChild as Text;
        document.getSelection()!.setBaseAndExtent(text, 0, text, Math.min(text.data.length, 32));
        node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      });
      await page.locator('#card').waitFor({ state: 'visible' });
    };
    await selectPhrase('figure-6', /Block table translation/i);
    await page.locator('#card .highlight-dot[data-color="green"]').click();
    await selectPhrase('block-tables', /KV block manager/i);
    await page.locator('#card .highlight-dot[data-color="purple"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#original .annotation-highlight').length >= 3);
    const createdColors = new Set((await marks()).map(m => m.color));
    assert.deepEqual(createdColors, new Set(['yellow', 'green', 'purple']), '1-click color dots must persist yellow, green, and purple highlights.');

    const reader=page.locator('#reader'), rail=page.locator('#rail'), marksTab=page.locator('#annotationsTab');
    await page.locator('#mobileRail').click();
    await marksTab.click();
    assert.equal(await rail.locator('.annotation-entry').count(), 3);
    await rail.locator('.annotation-color-filter[data-color-filter="purple"]').click();
    assert.equal(await rail.locator('.annotation-entry').count(), 1);
    assert.ok((await rail.locator('.annotation-entry').first().innerText()).includes('Question'));
    await rail.locator('.annotation-color-filter[data-color-filter="all"]').click();
    const search = rail.locator('.annotation-search');
    await search.fill('KV block manager');
    assert.ok(await search.evaluate(el => el === document.activeElement), 'Typing in Marks search must not lose focus.');
    assert.equal(await rail.locator('.annotation-entry').count(), 1);
    await search.fill('no-such-mark-xyz');
    await rail.getByText('No marks match the current filter.', { exact: true }).waitFor();
    await rail.getByRole('button', { name: 'Clear filters', exact: true }).click();
    assert.equal(await rail.locator('.annotation-entry').count(), 3);
    await page.locator('#notesTab').click();
    const presentation=rail.getByRole('combobox',{name:'Highlight display'});
    assert.equal(await presentation.count(),1,'Readers can choose how highlights appear in their notebook.');
    assert.equal(await presentation.inputValue(),'inline');
    const inline=rail.locator('.notebook-highlight');
    await inline.getByText(/the mapping between logical/i).waitFor();
    await presentation.selectOption('separate');
    assert.equal(await inline.count(),0);
    assert.equal((await book()).markdown,initialBook.markdown);
    await marksTab.click();
    await rail.locator('.annotation-entry').first().click();
    await rail.getByRole('button',{name:'Green',exact:true}).click();
    const comment=rail.getByRole('textbox',{name:'Comment',exact:true});
    await comment.fill('Use this as evidence of block indirection.');
    await page.locator('#notebookPose').selectOption('float');
    assert.equal(await reader.getAttribute('data-notebook-pose'),'float');
    assert.equal(await comment.inputValue(),'Use this as evidence of block indirection.');
    await capture('Floating notebook');
    await page.locator('#notebookPose').selectOption('left');
    assert.equal(await reader.getAttribute('data-notebook-pose'),'left');
    await rail.getByRole('button',{name:'Save',exact:true}).click();
    await rail.locator('.annotation-workspace').getByRole('heading',{name:'Marks',exact:true}).waitFor();
    assert.equal((await marks())[0].color,'green');
    await capture('Docked notebook');
    await rail.locator('.annotation-entry').first().click();
    await comment.fill('Trace the mapping before comparing throughput.');
    await page.reload();await loaded(page);await marksTab.click();await rail.locator('.annotation-entry').first().click();
    assert.equal(await comment.inputValue(),'Trace the mapping before comparing throughput.');
    const latest=(await marks())[0];
    await action('annotation.save',{...latest,text:'Changed in another reader.',expectedUpdatedAt:latest.updatedAt});
    await rail.getByRole('button',{name:'Save',exact:true}).click();
    await rail.getByText('Changed in another reader.',{exact:true}).waitFor();
    assert.equal(await comment.inputValue(),'Trace the mapping before comparing throughput.');
    await rail.getByRole('button',{name:'Keep my draft'}).click();
    await rail.getByRole('button',{name:'Save',exact:true}).click();
    await rail.locator('.annotation-workspace').getByRole('heading',{name:'Marks',exact:true}).waitFor();
    await page.locator('#closeRail').click();

    async function pin(text:string,figure:string){
      const target=page.locator('#original .pdf-figure[data-block-id="'+figure+'"]');
      await target.scrollIntoViewIfNeeded();
      const bounds=(await target.boundingBox())!;
      await page.locator('#placePin').click();const cross=page.locator('.annotation-placement');
      if(figure==='figure-6'){
        await cross.press('ArrowLeft');await cross.press('Escape');
        assert.equal(await page.locator('#placePin').getAttribute('aria-pressed'),'false');
        await page.locator('#placePin').click();
      }
      await page.mouse.click(bounds.x+bounds.width*.16,bounds.y+bounds.height*.35);
      const popup=page.getByRole('region',{name:'Page note',exact:true});
      await popup.getByRole('textbox',{name:'Comment'}).fill(text);
      if(figure==='figure-6'){
        const card=(await popup.boundingBox())!;
        assert.ok(card.x+card.width<=bounds.x || card.x>=bounds.x+bounds.width ||
          card.y+card.height<=bounds.y || card.y>=bounds.y+bounds.height,'Writing the margin note should leave the figure visible.');
        await capture('At Figure 6');
      }
      await popup.getByRole('button',{name:'Save',exact:true}).click();
      await popup.waitFor({state:'hidden'});
    }
    const first='Figure 6: why does logical block zero map to physical block seven?';
    await pin(first,'figure-6');
    assert.equal((await book()).markdown,initialBook.markdown);
    await go(7);await pin('Figure 8: trace the write after sharing the initial blocks.','figure-8');
    assert.equal((await marks()).length,5);
    await page.locator('#mobileRail').click();await marksTab.click();
    const cite=async(value:string)=>{
      await rail.locator('.annotation-entry').filter({hasText:value}).click();
      await rail.getByRole('button',{name:'Cite in Notes'}).click();
      await rail.locator('.notebook-passage-link').last().waitFor();
    };
    await cite(first);
    await marksTab.click(); await cite('Figure 8:');
    const links=rail.locator('.notebook-passage-link');
    const firstLink=links.filter({hasText:'p. 6'}).first(), secondLink=links.filter({hasText:'p. 7'}).first();
    await secondLink.waitFor();const firstHref=(await firstLink.getAttribute('href'))!, secondHref=(await secondLink.getAttribute('href'))!;
    assert.match(new URL(firstHref).searchParams.get('anchor')!,/^point-/);
    await firstLink.click();await page.waitForURL(url=>url.searchParams.get('page')==='6');await loaded(page);
    await page.locator('#original .annotation-pin').first().waitFor();
    await page.locator('#zoom').selectOption('1.5');
    const savedPin=(await marks()).find(n=>n.kind==='pin'&&n.page===6)!;
    const sheet=page.locator('#original .pdf-sheet');
    const paperBounds=(await sheet.boundingBox())!, pinBounds=(await sheet.locator('.annotation-pin').first().boundingBox())!;
    assert.ok(Math.abs(pinBounds.x+pinBounds.width/2-paperBounds.x-paperBounds.width*savedPin.point!.x)<2);
    assert.ok(Math.abs(pinBounds.y+pinBounds.height/2-paperBounds.y-paperBounds.height*savedPin.point!.y)<2);
    await secondLink.click();await page.waitForURL(url=>url.searchParams.get('page')==='7');await loaded(page);
    await page.locator('#original .annotation-pin').first().waitFor();
    await page.locator('#zoom').selectOption('1');
    await marksTab.click();
    const firstEntry=rail.locator('.annotation-entry').filter({hasText:first});
    await firstEntry.click();
    const removeBtn = rail.locator('.annotation-editor-actions .annotation-remove');
    await removeBtn.waitFor({ state: 'visible' });
    const rowBoxes = await Promise.all([
      rail.locator('.annotation-editor-actions .btn.primary').boundingBox(),
      removeBtn.boundingBox()
    ]);
    assert.ok(rowBoxes[0] && rowBoxes[1] && Math.abs(rowBoxes[0].y - rowBoxes[1].y) < 12 && rowBoxes[1].x > rowBoxes[0].x,
      'Remove button must align on the same row to the right of Save/Cite in Notes.');
    await assertContrast(removeBtn, '.annotation-remove (light)', 4.5);
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme-switching', ''); document.documentElement.setAttribute('data-theme', 'dark'); });
    await assertContrast(removeBtn, '.annotation-remove (dark)', 4.5);
    await page.evaluate(() => { document.documentElement.removeAttribute('data-theme'); document.documentElement.removeAttribute('data-theme-switching'); });
    await removeBtn.click();
    await rail.getByRole('button',{name:'Remove mark',exact:true}).click();await firstEntry.waitFor({state:'detached'});
    assert.equal((await marks()).length,4);
    const revisit=await ctx.newPage();await revisit.goto(firstHref);await loaded(revisit);
    assert.equal(new URL(revisit.url()).searchParams.get('anchor'),new URL(firstHref).searchParams.get('anchor'));
    await revisit.locator('#original .annotation-location').waitFor();
    await revisit.close();await page.locator('#toast').getByText('Undo',{exact:true}).click();await firstEntry.waitFor();
    assert.equal((await marks()).length,5);
    assert.equal(await rail.getByRole('button', { name: 'Export to Obsidian', exact: true }).isVisible(), false);
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const copiedPack = async (tab: '#notesTab' | '#annotationsTab') => {
      await page.locator(tab).click();
      await rail.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
      await page.locator('#toast').getByText('Markdown copied to clipboard.', { exact: true }).waitFor();
      return page.evaluate(() => navigator.clipboard.readText());
    };
    const fromMarks = await copiedPack('#annotationsTab');
    assert.ok(fromMarks.startsWith('---\n') && fromMarks.includes('## Highlights & Page Notes') && fromMarks.includes('### Page 6') && fromMarks.includes('### Page 7'));
    assert.ok(fromMarks.includes(first) && fromMarks.includes('Figure 8: trace the write'));
    assert.doesNotMatch(fromMarks, /localhost|127\.0\.0\.1|\/api\/paper-reader\/app\//);
    const fromNotes = await copiedPack('#notesTab');
    assert.equal(fromNotes, fromMarks);
    const [mdDownload] = await Promise.all([page.waitForEvent('download'), rail.getByRole('button', { name: 'Download .md', exact: true }).click()]);
    const savedMd = await readDownload(mdDownload);
    assert.match(savedMd.filename, /^[a-z0-9]+\.md$/);
    assert.equal(savedMd.text, fromNotes);
    await blockClipboard(page);
    await rail.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
    await page.locator('#toast').getByText('Clipboard access was blocked. Use Download instead.', { exact: true }).waitFor();
    await restoreClipboard(page);
    const firstSaved = (await marks()).find(m => m.text === first)!;
    await action('annotation.delete', { docId: 'pagedattention', id: firstSaved.id, expectedUpdatedAt: firstSaved.updatedAt });
    await page.reload(); await loaded(page); await marksTab.click();
    const afterDelete = await copiedPack('#annotationsTab');
    assert.ok(!afterDelete.includes(first) && afterDelete.includes('Figure 8: trace the write'));
    await page.locator('#parallel').click();assert.equal(await reader.getAttribute('data-notebook-pose'),'left');await capture('Bilingual notes');
    await page.setViewportSize({width:390,height:844});await page.goto(secondHref);await loaded(page);
    await page.locator('#mobileRail').click();await marksTab.click();
    await assertMobilePanelTargets(page, '#rail');
    await page.locator('#closeRail').click();
    await page.locator('#original .annotation-pin').first().click();await rail.getByRole('textbox',{name:'Comment'}).waitFor();
    assert.equal(await reader.getAttribute('data-notebook-pose'),'sheet');
    await capture('Mobile page note');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1),true);
    assert.deepEqual(errors,[]);console.log('Passed: mark-only indexing, color, float/dock, persistent PDF pins, citations across pages, deletion/undo, original-page links, bilingual and mobile sheet.');
  } finally {await browser.close();}
});
