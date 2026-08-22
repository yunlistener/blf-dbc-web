"""生成测试数据:test.dbc + test.blf(约 10 秒,10ms 周期,2 个报文)。

运行: python scripts/make_test_data.py
"""
import math
import random
from pathlib import Path

import can
import cantools

UPLOADS = Path(__file__).resolve().parent.parent.parent / "data" / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)

DBC_TEXT = '''VERSION ""

NS_ :
    NS_DESC_
    CM_
    BA_DEF_
    BA_
    VAL_
    CAT_DEF_
    CAT_
    FILTER
    BA_DEF_DEF_
    EV_DATA_
    ENVVAR_DATA_
    SGTYPE_
    SGTYPE_VAL_
    BA_DEF_SGTYPE_
    BA_SGTYPE_
    SIG_TYPE_REF_
    VAL_TABLE_
    SIG_GROUP_
    SIG_VALTYPE_
    SIGTYPE_VALTYPE_
    BO_TX_BU_
    BA_DEF_REL_
    BA_REL_
    BA_DEF_DEF_REL_
    BU_SG_REL_
    BU_EV_REL_
    BU_BO_REL_
    SG_MUL_VAL_

BS_:

BU_ : ECU

BO_ 291 EngineData: 8 ECU
 SG_ EngineSpeed : 16|16@1+ (0.125,0) [0|8000] "rpm" ECU
 SG_ CoolantTemp : 8|8@1+ (1,-40) [-40|215] "degC" ECU

BO_ 292 VehicleSpeed: 8 ECU
 SG_ VehicleSpeed : 0|16@1+ (0.01,0) [0|655.35] "km/h" ECU

VAL_ 291 EngineSpeed 0 "Off" 1 "On";
'''


def main():
    dbc_path = UPLOADS / "test.dbc"
    dbc_path.write_text(DBC_TEXT, encoding="utf-8")
    db = cantools.database.load_file(str(dbc_path))

    blf_path = UPLOADS / "test.blf"
    t = 0.0
    with can.BLFWriter(str(blf_path), channel=1) as writer:
        while t < 10.0:
            # 发动机转速:0.5Hz 正弦 + 噪声
            rpm = 1000 + 500 * math.sin(2 * math.pi * 0.5 * t) + random.uniform(-20, 20)
            data = db.encode_message(291, {"EngineSpeed": rpm, "CoolantTemp": 80 + t})
            writer.on_message_received(can.Message(
                arbitration_id=291, data=data, timestamp=t, is_extended_id=False))

            # 车速:0.2Hz 正弦
            speed = 50 + 30 * math.sin(2 * math.pi * 0.2 * t)
            data = db.encode_message(292, {"VehicleSpeed": speed})
            writer.on_message_received(can.Message(
                arbitration_id=292, data=data, timestamp=t, is_extended_id=False))
            t += 0.01

    print(f"已生成: {dbc_path}  ({dbc_path.stat().st_size} B)")
    print(f"已生成: {blf_path}  ({blf_path.stat().st_size} B)")


if __name__ == "__main__":
    main()
