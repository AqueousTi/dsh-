"""QQ private dual-output replies: native text delivery, then optional speech.

No background tasks, provider replacement, or global event state. The caller
keeps native segmentation, reply decoration, and one after-send hook per result.
"""
import asyncio
from dataclasses import dataclass

from astrbot.core import file_token_service, logger
from astrbot.core.message.components import At, Image, Plain, Record, Reply
from astrbot.core.platform.message_type import MessageType

KEY = "_dfy_deferred_tts_v1"


@dataclass
class Pending:
    result: object
    provider: object
    components: tuple
    use_file_service: bool
    callback_api_base: str


def prepare(stage, event, result, provider):
    """Called only after the native probability and session TTS checks pass."""
    cfg = stage.ctx.astrbot_config
    if (
        event.get_platform_name() != "aiocqhttp"
        or event.get_message_type() != MessageType.FRIEND_MESSAGE
        or not cfg["provider_tts_settings"]["dual_output"]
        or not all(isinstance(c, (Plain, Image, At, Reply)) for c in result.chain)
        or sum(len(c.text) for c in result.chain if isinstance(c, Plain))
        > stage.forward_threshold
    ):
        return False
    components = tuple(c for c in result.chain if isinstance(c, Plain) and len(c.text) > 1)
    if not components:
        return False
    event.set_extra(KEY, Pending(
        result, provider, components,
        bool(cfg["provider_tts_settings"]["use_file_service"]),
        cfg["callback_api_base"],
    ))
    return True


async def finish(stage, event, result, delivered):
    """Only synthesize segments whose text send succeeded; never resend text."""
    pending = event.get_extra(KEY)
    # Consume before awaiting: repeated stages cannot duplicate audio.
    event.set_extra(KEY, None)
    if not isinstance(pending, Pending) or pending.result is not result:
        return
    sent_ids = {id(c) for c in delivered}
    for comp in pending.components:
        if id(comp) not in sent_ids or event.is_stopped():
            continue
        try:
            audio_path = await pending.provider.get_audio(comp.text)
            if not audio_path:
                logger.warning("[DFY voice] No audio; previously delivered text retained.")
                continue
            url = None
            if pending.use_file_service and pending.callback_api_base:
                token = await file_token_service.register_file(audio_path)
                url = f"{pending.callback_api_base}/api/file/{token}"
            record = Record(file=url or audio_path, url=url or audio_path, text=comp.text)
            if stage.is_seg_reply_required(event):
                await asyncio.sleep(await stage._reply_interval(event, record))
            await event.send(result.derive([record]))
        except Exception as exc:
            # Do not log text, filenames, callback tokens, or provider response bodies.
            logger.warning(
                f"[DFY voice] Speech skipped ({type(exc).__name__}); text retained."
            )

