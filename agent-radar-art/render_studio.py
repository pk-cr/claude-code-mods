import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chibi, chibi_studio as cs
chibi.LOOKS_STUDIO = cs.CREW; chibi.LOOKS = cs.CREW; chibi.build = cs.build; chibi.palette = cs.pal
chibi.board('9-studio-board.png'); cs.faces(); chibi.studio_mock('10-studio-mock.png', 4); chibi.studio_mock('10b-studio-mock-real.png', 2)
print('ok')
