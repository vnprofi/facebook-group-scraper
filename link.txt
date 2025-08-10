import time
import random
import csv
import os
import tkinter as tk
from tkinter import filedialog, messagebox
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.chrome.service import Service
import pandas as pd
import urllib.parse
import re


def human_delay(min_delay=1, max_delay=3):
    time.sleep(random.uniform(min_delay, max_delay))


def clean_facebook_url(url):
    """Очищает Facebook редирект ссылки и извлекает реальный URL"""
    try:
        # Если это Facebook редирект
        if 'l.facebook.com/l.php' in url:
            # Извлекаем параметр u из URL
            parsed = urllib.parse.urlparse(url)
            query_params = urllib.parse.parse_qs(parsed.query)
            if 'u' in query_params:
                real_url = query_params['u'][0]
                # Убираем fbclid параметр
                if '?fbclid=' in real_url:
                    real_url = real_url.split('?fbclid=')[0]
                elif '&fbclid=' in real_url:
                    real_url = real_url.split('&fbclid=')[0]
                return real_url
        
        # Убираем fbclid из обычных ссылок
        if '?fbclid=' in url:
            url = url.split('?fbclid=')[0]
        elif '&fbclid=' in url:
            url = url.split('&fbclid=')[0]
        
        return url
    except:
        return url


def is_social_link(url):
    """Проверяет, является ли ссылка социальной сетью"""
    social_domains = [
        'instagram.com', 'tiktok.com', 'vk.com', 'ok.ru', 
        'telegram.org', 't.me', 'youtube.com', 'twitter.com',
        'linkedin.com', 'whatsapp.com', 'viber.com'
    ]
    
    for domain in social_domains:
        if domain in url.lower():
            return True
    return False


def setup_stealth_driver():
    """Настройка браузера с антидетекцией и отключением логов"""
    options = webdriver.ChromeOptions()
    
    # Отключение логов DevTools и других сообщений
    options.add_argument("--log-level=3")  # Только критические ошибки
    options.add_argument("--silent")
    options.add_argument("--disable-logging")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-gpu")
    options.add_argument("--remote-debugging-port=0")  # Отключение remote debugging
    
    # Основные настройки антидетекции
    options.add_argument("--start-maximized")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--disable-infobars")
    options.add_argument("--disable-web-security")
    options.add_argument("--allow-running-insecure-content")
    options.add_argument("--disable-features=VizDisplayCompositor")
    
    # Отключаем флаги автоматизации
    options.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])
    options.add_experimental_option('useAutomationExtension', False)
    
    # Отключение логирования
    options.add_experimental_option("excludeSwitches", ["enable-logging"])
    options.add_experimental_option('useAutomationExtension', False)
    
    # Случайный User-Agent
    user_agents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ]
    options.add_argument(f"user-agent={random.choice(user_agents)}")
    
    # Создаем драйвер с подавлением логов
    service = Service(ChromeDriverManager().install())
    service.creationflags = 0x08000000  # Скрыть окно консоли на Windows
    
    driver = webdriver.Chrome(service=service, options=options)
    
    # Скрипты для дополнительной маскировки
    stealth_scripts = [
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})",
        "Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]})",
        "Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']})",
        "window.chrome = {runtime: {}}",
        "Object.defineProperty(navigator, 'permissions', {get: () => ({query: () => Promise.resolve({state: 'granted'})})})"
    ]
    
    for script in stealth_scripts:
        try:
            driver.execute_script(script)
        except:
            pass
    
    return driver


def extract_profile_data(target_div):
    """Извлекает данные профиля до раздела 'Актуальное'"""
    lines = [line.strip() for line in target_div.stripped_strings]
    actual_index = next((i for i, line in enumerate(lines) if 'Актуальное' in line), None)
    profile_info = lines[:actual_index] if actual_index is not None else lines
    cleaned_lines = [line.replace('\u200b', '').strip() for line in profile_info if line.strip()]
    return '\n'.join(cleaned_lines)


def extract_name(soup):
    """Извлекает ФИО из h1 с указанными классами"""
    name_h1 = soup.find('h1',
                        class_='html-h1 xdj266r x14z9mp xat24cr x1lziwak xexx8yu xyri2b x18d9i69 x1c1uobl x1vvkbs x1heor9g x1qlqyl8 x1pd3egz x1a2a7pz')
    if name_h1:
        name_text = name_h1.get_text(strip=True)
        name_text = name_text.replace('\u00a0', ' ').strip()
        return name_text
    return "Не найдено"


def scrape_facebook_links(driver):
    """Собирает все ссылки из профиля Facebook с текстом и очищает их"""
    try:
        # Ждем немного для загрузки страницы
        human_delay(2, 3)
        
        # Ищем все ссылки на странице
        link_selectors = [
            'a[href*="l.facebook.com/l.php"]',  # Редирект ссылки
            'a[href*="instagram.com"]',
            'a[href*="tiktok.com"]',
            'a[href*="vk.com"]',
            'a[href*="ok.ru"]',
            'a[href*="t.me"]',
            'a[href*="telegram"]',
            'a[href*="youtube.com"]',
            'a[href*="twitter.com"]',
            'a[href*="linkedin.com"]',
            'a.x1i10hfl.xjbqb8w.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.xt0psk2.xe8uvvx.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x16tdsg8.x1hl2dhg.xggy1nq.x1a2a7pz.xkrqix3.x1sur9pj.x1qq9wsj.x1s688f'
        ]
        
        all_elements = []
        for selector in link_selectors:
            try:
                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                all_elements.extend(elements)
            except:
                continue
        
        # Убираем дубликаты
        seen_hrefs = set()
        unique_elements = []
        for element in all_elements:
            href = element.get_attribute('href')
            if href and href not in seen_hrefs:
                seen_hrefs.add(href)
                unique_elements.append(element)
        
        links_data = []
        for element in unique_elements:
            try:
                text = element.text.strip()
                href = element.get_attribute('href')
                
                # Фильтруем нежелательные ссылки
                if (href and 
                    'recover' not in href.lower() and 
                    'password' not in href.lower() and
                    'login' not in href.lower() and
                    'signup' not in href.lower() and
                    'facebook.com/privacy' not in href.lower() and
                    'facebook.com/help' not in href.lower()):
                    
                    # Очищаем URL
                    clean_url = clean_facebook_url(href)
                    
                    # Проверяем, что это внешняя ссылка или социальная сеть
                    if (is_social_link(clean_url) or 
                        ('facebook.com' not in clean_url and 'http' in clean_url)):
                        
                        # Если текста нет, используем домен
                        if not text or len(text) < 3:
                            try:
                                domain = urllib.parse.urlparse(clean_url).netloc
                                text = domain.replace('www.', '')
                            except:
                                text = "Ссылка"
                        
                        links_data.append(f"{text} | {clean_url}")
                        
            except Exception:
                continue
        
        # Убираем дубликаты по URL
        unique_links = []
        seen_urls = set()
        for link_data in links_data:
            url = link_data.split(' | ')[-1]
            if url not in seen_urls:
                seen_urls.add(url)
                unique_links.append(link_data)
        
        # Объединяем все ссылки через разделитель
        return " --- ".join(unique_links) if unique_links else "Ссылки не найдены"
        
    except Exception as e:
        print(f"⚠️ Ошибка при сборе ссылок: {e}")
        return "Ошибка при сборе ссылок"


def scrape_profile_data(driver, profile_url):
    print(f"🌐 Переход к профилю: {profile_url}")
    driver.get(profile_url)
    human_delay(3, 6)

    try:
        window_size = driver.get_window_size()
        max_x = min(100, window_size['width'] // 2)
        max_y = min(100, window_size['height'] // 2)
        if max_x > 10 and max_y > 10:
            actions = ActionChains(driver)
            actions.move_by_offset(random.randint(10, max_x), random.randint(10, max_y)).perform()
            human_delay(1, 2)
    except Exception:
        pass

    soup = BeautifulSoup(driver.page_source, 'html.parser')
    target_div = soup.find('div', class_='xieb3on')

    if not target_div:
        print("⚠️ Блок <div class='xieb3on'> не найден.")
        return None, None, None

    print("✅ Блок найден!")
    formatted_profile = extract_profile_data(target_div)
    name = extract_name(soup)
    
    # Собираем все ссылки из профиля
    print("🔗 Собираю ссылки из профиля...")
    all_links = scrape_facebook_links(driver)
    
    return formatted_profile, name, all_links


def get_links_from_file():
    """Получает ссылки из файла по указанному пути"""
    while True:
        file_path = input("Введите ПОЛНЫЙ ПУТЬ к файлу со ссылками: ").strip().replace('"', '')

        if not file_path:
            print("❌ Путь не может быть пустым!")
            continue

        if not os.path.exists(file_path):
            print(f"❌ Файл не найден: {file_path}")
            retry = input("Попробовать снова? (y/n): ").lower()
            if retry != 'y':
                return []
            continue

        try:
            with open(file_path, 'r', encoding='utf-8') as file:
                links = []
                for line_num, line in enumerate(file, 1):
                    line = line.strip()
                    if line and 'facebook.com' in line:
                        links.append(line)
                    elif line and 'facebook.com' not in line:
                        print(f"⚠️ Строка {line_num} пропущена (не Facebook ссылка): {line[:50]}...")

                if links:
                    print(f"✅ Загружено {len(links)} ссылок из файла")
                    return links
                else:
                    print("❌ В файле не найдено валидных Facebook ссылок")
                    return []

        except Exception as e:
            print(f"❌ Ошибка при чтении файла: {e}")
            return []


def get_links_manually():
    """Получает ссылки ручным вводом"""
    print("\n📝 РУЧНОЙ ВВОД ССЫЛОК")
    print("Вводите ссылки по одной. Для завершения введите 'stop'")
    print("Пример: https://www.facebook.com/username")
    print("-" * 50)

    links = []
    while True:
        link = input(f"Ссылка #{len(links) + 1} (или 'stop' для завершения): ").strip()

        if link.lower() == 'stop':
            break

        if not link:
            continue

        if 'facebook.com' in link:
            links.append(link)
            print(f"✅ Добавлена ссылка #{len(links)}")
        else:
            print("❌ Неверная ссылка. Используйте ссылки Facebook.")

    return links


def get_links_paste():
    """Получает ссылки массовой вставкой"""
    print("\n📄 МАССОВАЯ ВСТАВКА ССЫЛОК")
    print("После вставки ссылок введите 'END' на новой строке")
    print("-" * 50)

    links = []
    print("Вставляйте ссылки (каждая с новой строки):")

    while True:
        line = input().strip()

        if line.upper() == 'END':
            break

        if not line:
            continue

        if 'facebook.com' in line:
            links.append(line)
            print(f"✅ Добавлена ссылка #{len(links)}")
        else:
            print(f"❌ Пропущена: {line[:50]}...")

    return links


def get_links_from_user():
    """Получает ссылки от пользователя"""
    print("\n" + "=" * 60)
    print("📋 ВЫБЕРИТЕ СПОСОБ ДОБАВЛЕНИЯ ССЫЛОК")
    print("=" * 60)
    print("1. Загрузить из файла (указать путь)")
    print("2. Ввести вручную по одной")
    print("3. Вставить массово (копипаст)")
    print("-" * 60)

    while True:
        choice = input("Ваш выбор (1/2/3): ").strip()

        if choice == "1":
            return get_links_from_file()
        elif choice == "2":
            return get_links_manually()
        elif choice == "3":
            return get_links_paste()
        else:
            print("❌ Выберите 1, 2 или 3!")


def choose_save_location_and_format():
    """Выбор места сохранения и формата файла"""
    print("\n" + "=" * 60)
    print("💾 ВЫБЕРИТЕ ФОРМАТ СОХРАНЕНИЯ")
    print("=" * 60)
    print("1. CSV файл (.csv)")
    print("2. Excel файл (.xlsx)")
    print("-" * 60)
    
    while True:
        format_choice = input("Ваш выбор (1/2): ").strip()
        if format_choice in ["1", "2"]:
            break
        print("❌ Выберите 1 или 2!")
    
    # Скрытое окно tkinter для диалога сохранения
    root = tk.Tk()
    root.withdraw()  # Скрываем главное окно
    
    if format_choice == "1":
        file_path = filedialog.asksaveasfilename(
            title="Сохранить CSV файл",
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        return file_path, "csv"
    else:
        file_path = filedialog.asksaveasfilename(
            title="Сохранить Excel файл",
            defaultextension=".xlsx",
            filetypes=[("Excel files", "*.xlsx"), ("All files", "*.*")]
        )
        return file_path, "excel"


def save_data(data, file_path, format_type):
    """Сохранение данных в выбранном формате"""
    if not file_path:
        print("❌ Файл не выбран!")
        return False
    
    try:
        if format_type == "csv":
            with open(file_path, 'w', newline='', encoding='utf-8') as csvfile:
                writer = csv.writer(csvfile, delimiter=';', quotechar='"', quoting=csv.QUOTE_ALL)
                writer.writerow(['Ссылка на объект', 'ФИО', 'Полная карточка объекта', 'Все ссылки'])
                for row in data:
                    cleaned_row = []
                    for cell in row:
                        cleaned_cell = str(cell).replace('\u200b', '').replace('\n', ' ').replace('\r', ' ')
                        cleaned_row.append(cleaned_cell)
                    writer.writerow(cleaned_row)
        
        elif format_type == "excel":
            # Подготавливаем данные для DataFrame
            df_data = []
            for row in data:
                cleaned_row = []
                for cell in row:
                    cleaned_cell = str(cell).replace('\u200b', '').replace('\n', ' ').replace('\r', ' ')
                    cleaned_row.append(cleaned_cell)
                df_data.append(cleaned_row)
            
            df = pd.DataFrame(df_data, columns=['Ссылка на объект', 'ФИО', 'Полная карточка объекта', 'Все ссылки'])
            df.to_excel(file_path, index=False, engine='openpyxl')
        
        print(f"✅ Файл сохранен: {file_path}")
        return True
        
    except Exception as e:
        print(f"❌ Ошибка при сохранении: {e}")
        return False


def main():
    print("🚀 FACEBOOK PROFILE SCRAPER")
    print("=" * 60)

    # Получаем ссылки
    profile_links = get_links_from_user()

    if not profile_links:
        print("\n❌ Нет ссылок для обработки!")
        input("Нажмите Enter для выхода...")
        return

    print(f"\n📊 ГОТОВО К ОБРАБОТКЕ: {len(profile_links)} профилей")

    # Показываем ссылки для проверки
    if len(profile_links) <= 10:
        print("\n🔍 Список ссылок:")
        for i, link in enumerate(profile_links, 1):
            print(f"  {i}. {link}")
    else:
        print(f"\n🔍 Первые 5 ссылок из {len(profile_links)}:")
        for i, link in enumerate(profile_links[:5], 1):
            print(f"  {i}. {link}")
        print(f"  ... и еще {len(profile_links) - 5}")

    # Подтверждение
    print("\n" + "-" * 60)
    confirm = input("🚀 НАЧАТЬ ОБРАБОТКУ? (y/n): ").lower()
    if confirm != 'y':
        print("Отменено.")
        return

    print("\n🔧 Запуск браузера...")

    # Настройка браузера с собственной антидетекцией
    driver = setup_stealth_driver()

    try:
        print("🔐 Открываю Facebook для авторизации...")
        driver.get("https://www.facebook.com/login")
        human_delay(2, 4)

        try:
            window_size = driver.get_window_size()
            safe_x = random.randint(10, min(100, window_size['width'] // 4))
            safe_y = random.randint(10, min(100, window_size['height'] // 4))
            actions = ActionChains(driver)
            actions.move_by_offset(safe_x, safe_y).perform()
        except:
            pass

        print("\n" + "=" * 60)
        print("🔑 ВОЙДИТЕ В СВОЙ АККАУНТ FACEBOOK В ОТКРЫВШЕМСЯ БРАУЗЕРЕ")
        print("=" * 60)
        input("После входа нажмите Enter для продолжения ➡️ ")

        human_delay(3, 6)

        print("\n🚀 НАЧИНАЮ ОБРАБОТКУ ПРОФИЛЕЙ...")
        print("=" * 60)

        results = []
        for i, profile_url in enumerate(profile_links, 1):
            print(f"\n📊 [{i}/{len(profile_links)}] Обрабатываю профиль...")
            try:
                formatted_profile, name, all_links = scrape_profile_data(driver, profile_url)
                if formatted_profile:
                    results.append([profile_url, name, formatted_profile, all_links])
                    print(f"✅ Успешно: {name}")
                    link_count = len(all_links.split(' --- ')) if all_links != 'Ссылки не найдены' and all_links != 'Ошибка при сборе ссылок' else 0
                    print(f"🔗 Найдено очищенных ссылок: {link_count}")
                else:
                    results.append([profile_url, name if name else "Не найдено", "Не найдено", "Ссылки не найдены"])
                    print("❌ Данные не получены")
            except Exception as e:
                print(f"❌ Ошибка: {e}")
                results.append([profile_url, "Ошибка", "Ошибка", "Ошибка при сборе ссылок"])

            # Пауза между профилями
            if i < len(profile_links):
                print("⏱️ Пауза...")
                human_delay(5, 10)

        # Выбор места сохранения и формата
        file_path, format_type = choose_save_location_and_format()
        
        # Сохранение результатов
        if save_data(results, file_path, format_type):
            print(f"\n💾 ГОТОВО! Результаты сохранены")
            print(f"📈 Обработано: {len(results)} профилей")
            print(f"📁 Расположение: {file_path}")
        else:
            print("❌ Ошибка при сохранении файла")

        print("\n" + "=" * 60)
        input("✅ Обработка завершена! Нажмите Enter для закрытия ➡️ ")

    except KeyboardInterrupt:
        print("\n⚠️ Программа прервана пользователем")
    except Exception as e:
        print(f"\n❌ Критическая ошибка: {e}")
    finally:
        try:
            driver.quit()
            print("🔒 Браузер закрыт.")
        except:
            pass
        input("Нажмите Enter для выхода...")


if __name__ == "__main__":
    main()
