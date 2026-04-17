import os

replacements = {
    'Fuerza de Tendencia Pro*': 'Fuerza de Tendencia Pro',
    'IA Predictiva Pro* (Markov)': 'IA Predictiva Pro (Markov)',
    'Radar de Ciclos Pro*': 'Radar de Ciclos Pro',
    'Detector de Rachas Pro*': 'Detector de Rachas Pro'
}

for root, dirs, files in os.walk('src'):
    for file in files:
        if file.endswith('.ts'):
            filepath = os.path.join(root, file)
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
            new_content = content
            for old, new in replacements.items():
                new_content = new_content.replace(old, new)
            if new_content != content:
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(new_content)
                print(f'Updated {filepath}')

with open('update.sql', 'r', encoding='utf-8') as f:
    sql = f.read()
for old, new in replacements.items():
    sql = sql.replace(old, new)
with open('update.sql', 'w', encoding='utf-8') as f:
    f.write(sql)
print('Updated update.sql')
