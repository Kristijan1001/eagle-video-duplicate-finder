'use strict';
// Generates a synthetic, Eagle-shaped test library under test/fixtures/library using the
// same FFmpeg Eagle ships (its FFmpeg dependency plugin). Every file has a known expected
// grouping, so the engine can be verified end to end:
//
//   A  (base)          10 s colour pattern + tonal audio
//   A_small            A re-encoded at 320x180            → duplicate of A
//   A_crf              A at very low quality              → duplicate of A
//   A_flip             A mirrored horizontally            → duplicate of A (flipped)
//   A_box              A with a box "watermark"           → duplicate of A
//   B, C               unrelated videos                   → no group
//   L                  60 s long recording (4 scenes)
//   L_clip             L from 20 s to 35 s                → partial clip of L @ ~20 s
//   A_zoom             A cropped 70% + colour-graded      → AI-only duplicate of A
//   L_silent_part      L 8..48 s, no audio               → AI partial clip of L
//   dark               black video                        → excluded (too dark)
//   img, img_small, img_flip → one image group; img_other → none

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const lib = path.join(root, 'test', 'fixtures', 'library');
const ffmpeg = process.env.FFMPEG || path.join(process.env.APPDATA || '', 'Eagle', 'Plugins', 'ffmpeg-win-x64', 'ffmpeg.exe');

function run(args) {
	const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}\n${r.stderr}`);
}

const items = [];
function out(id, name, ext) {
	const dir = path.join(lib, 'images', `${id}.info`);
	fs.mkdirSync(dir, { recursive: true });
	items.push({ id, name, ext, folders: [] });
	return path.join(dir, `${name}.${ext}`);
}

// A melody-like tone sequence so the audio fingerprint has pitch structure to track.
const melody = (seed) => `aevalsrc='0.4*sin(2*PI*(220*pow(2,mod(floor(t*3)*${seed},12)/12))*t)+0.2*sin(2*PI*(330*pow(2,mod(floor(t*2)*${seed + 2},12)/12))*t)':s=44100:d=`;

fs.rmSync(lib, { recursive: true, force: true });
fs.mkdirSync(lib, { recursive: true });

const A = out('FIXA00000001', 'A', 'mp4');
run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=10', '-f', 'lavfi', '-i', melody(5) + '10',
	'-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', A]);
run(['-i', A, '-vf', 'scale=320:180', '-c:v', 'libx264', '-crf', '23', '-c:a', 'copy', out('FIXA00000002', 'A_small', 'mp4')]);
run(['-i', A, '-c:v', 'libx264', '-crf', '40', '-c:a', 'copy', out('FIXA00000003', 'A_crf', 'mkv')]);
run(['-i', A, '-vf', 'hflip', '-c:v', 'libx264', '-c:a', 'copy', out('FIXA00000004', 'A_flip', 'mp4')]);
run(['-i', A, '-vf', 'drawbox=x=520:y=300:w=100:h=40:color=white@1:t=fill', '-c:v', 'libx264', '-c:a', 'copy', out('FIXA00000005', 'A_box', 'mp4')]);

run(['-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=25', '-t', '10', '-f', 'lavfi', '-i', melody(7) + '10',
	'-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out('FIXB00000001', 'B', 'mp4')]);
run(['-f', 'lavfi', '-i', 'gradients=size=640x360:rate=25:speed=0.02:c0=0x3070c0:c1=0xe0a040', '-t', '11', '-f', 'lavfi', '-i', 'anoisesrc=d=11:c=pink',
	'-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out('FIXC00000001', 'C', 'mp4')]);

// Long recording: four distinct scenes of 15 s each, with a changing melody.
const L = out('FIXL00000001', 'L', 'mp4');
run(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=15',
	'-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=15',
	'-f', 'lavfi', '-i', 'rgbtestsrc=size=640x360:rate=25:duration=15',
	'-f', 'lavfi', '-i', 'cellauto=size=640x360:rate=25:rule=110',
	'-f', 'lavfi', '-i', melody(3) + '60',
	'-filter_complex', '[3:v]trim=duration=15,setpts=PTS-STARTPTS[c];[0:v][1:v][2:v][c]concat=n=4:v=1:a=0,format=yuv420p[v]',
	'-map', '[v]', '-map', '4:a', '-c:v', 'libx264', '-c:a', 'aac', '-t', '60', L]);
run(['-ss', '20', '-i', L, '-t', '15', '-c:v', 'libx264', '-c:a', 'aac', out('FIXL00000002', 'L_clip', 'mp4')]);

// AI-only cases: a zoomed/cropped copy (classic gray compare misses it) and a SILENT trimmed
// clip (no audio, so only the AI keyframe pass can find it).
run(['-i', A, '-vf', 'crop=iw*0.7:ih*0.7,scale=640:360,eq=saturation=1.4:brightness=0.06', '-c:v', 'libx264', '-an', out('FIXA00000006', 'A_zoom', 'mp4')]);
run(['-ss', '8', '-i', L, '-t', '40', '-an', '-vf', 'scale=480:270', '-c:v', 'libx264', out('FIXL00000003', 'L_silent_part', 'mp4')]);

run(['-f', 'lavfi', '-i', 'color=c=black:size=640x360:rate=25:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out('FIXD00000001', 'dark', 'mp4')]);

const img = out('FIXI00000001', 'img', 'png');
run(['-f', 'lavfi', '-i', 'testsrc2=size=800x600:rate=1:duration=1', '-frames:v', '1', img]);
run(['-i', img, '-vf', 'scale=400:300', '-q:v', '3', out('FIXI00000002', 'img_small', 'jpg')]);
run(['-i', img, '-vf', 'hflip', out('FIXI00000003', 'img_flip', 'png')]);
run(['-f', 'lavfi', '-i', 'mandelbrot=size=800x600:rate=1', '-frames:v', '1', out('FIXI00000004', 'img_other', 'png')]);

for (const it of items) {
	const f = path.join(lib, 'images', `${it.id}.info`, `${it.name}.${it.ext}`);
	// Eagle keeps a "<name>_thumbnail.png" next to every file; make one the same way.
	const thumb = path.join(lib, 'images', `${it.id}.info`, `${it.name}_thumbnail.png`);
	const isImage = /png|jpg/.test(it.ext);
	run([...(isImage ? [] : ['-ss', '2']), '-i', f, '-vf', 'scale=400:-2', '-frames:v', '1', thumb]);
	it.size = fs.statSync(f).size;
	it.importedAt = Date.now();
	it.inScope = true;
}
fs.writeFileSync(path.join(root, 'test', 'fixtures', 'items.json'), JSON.stringify(items, null, 1));
console.log(`fixtures: ${items.length} items in ${lib}`);
