import fs from 'node:fs/promises';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../.env', import.meta.url) });

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY is missing');

const voicesResponse = await fetch('https://api.elevenlabs.io/v1/voices', {
  headers: { 'xi-api-key': key }
});
if (!voicesResponse.ok) throw new Error(`ElevenLabs voices HTTP ${voicesResponse.status}`);
const voices = await voicesResponse.json();
const wanted = String(process.env.ELEVENLABS_VOICE_NAME || 'Bos Hue').trim().toLowerCase();
const voice = (voices.voices || []).find((v) => String(v.name || '').trim().toLowerCase() === wanted);
if (!voice?.voice_id) throw new Error(`Voice not found: ${wanted}`);

const spoken = 'Bro, kenalkan Kerani. Supervisor site dalam WhatsApp. Hantar gambar dengan description, Kerani terus susun progress, material, attendance dan issue ikut site serta tarikh. Nak cari drawing, PDF atau rekod lama pun boleh. Set reminder meeting, nanti Kerani remind boss dengan voice. Satu bot, semua update site tersusun.';
const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.voice_id}?output_format=mp3_44100_128`, {
  method: 'POST',
  headers: {
    'xi-api-key': key,
    'Content-Type': 'application/json',
    Accept: 'audio/mpeg'
  },
  body: JSON.stringify({
    text: spoken,
    model_id: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    voice_settings: { stability: 0.48, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true }
  })
});
if (!response.ok) throw new Error(`ElevenLabs TTS HTTP ${response.status}`);
await fs.writeFile('promo-voice.mp3', Buffer.from(await response.arrayBuffer()));
console.log(`Voice generated: ${voice.name}`);
